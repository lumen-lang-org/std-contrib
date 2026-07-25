// A scalar/string-friendly C surface over libpq, for plume.
//
// libpq deals in connection and result handles, out-parameters, and arrays of
// rows. The Lumen FFI marshals only scalars and C strings, so this shim keeps
// each connection and its most recent result in a slot named by a small
// integer, and exposes the row/column reads as plain calls, the way the SQLite
// shim hides its out-pointers.
//
// A fixed table rather than malloc'd handles: the count is a resource limit
// worth having, an out-of-range handle is checked rather than dereferenced,
// and there is nothing to leak. Slot 0 is the process-wide connection, so a
// program that never asks for a second one behaves as it always did.
//
// Parameters are always sent out-of-band (PQexecParams), never pasted into SQL,
// so a document's text cannot end a quote and become statement text.
//
// Build:
//   cc -c plume_shim.c -I$(pg_config --includedir) -o plume_shim.o

#include <libpq-fe.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PL_MAX_CONNECTIONS 64
#define PL_MAX_PARAMS 32

// One connection, its live result, and the values waiting for its next query.
// The result belongs to the slot rather than to the shim: two handles used in
// turn would otherwise read each other's rows.
typedef struct {
    int taken;
    PGconn *conn;
    PGresult *res;
    // The FFI marshals one string per call, so an argument list arrives one
    // pl_bind at a time and is held here until pl_query sends it. Each is
    // copied: the caller's string lives only as long as the call.
    char *args[PL_MAX_PARAMS];
    char error[1024];
    char version[64];
} pl_slot;

static pl_slot g_slots[PL_MAX_CONNECTIONS];

static pl_slot *slot_of(int h) {
    if (h < 0 || h >= PL_MAX_CONNECTIONS) return NULL;
    return &g_slots[h];
}

static void set_error(pl_slot *s, const char *fallback) {
    const char *m = s->conn ? PQerrorMessage(s->conn) : NULL;
    if (m == NULL || *m == '\0') m = fallback;
    snprintf(s->error, sizeof(s->error), "%s", m);
    // libpq's messages end in a newline; trim it so callers can compose.
    size_t n = strlen(s->error);
    while (n > 0 && (s->error[n - 1] == '\n' || s->error[n - 1] == '\r')) s->error[--n] = '\0';
}

// libpq prints notices ("extension already exists, skipping") to stderr through
// a default handler. A library has no business writing to a caller's stderr —
// and the messages are not errors, so silencing them loses nothing a caller
// could act on. Real failures still arrive through PQerrorMessage.
static void swallow_notice(void *arg, const char *message) {
    (void)arg;
    (void)message;
}

static void clear_result(pl_slot *s) {
    if (s->res) {
        PQclear(s->res);
        s->res = NULL;
    }
}

static void clear_args(pl_slot *s) {
    for (int i = 0; i < PL_MAX_PARAMS; i++) {
        free(s->args[i]);
        s->args[i] = NULL;
    }
}

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection.
int pl_acquire(void) {
    for (int h = 1; h < PL_MAX_CONNECTIONS; h++) {
        if (!g_slots[h].taken) {
            g_slots[h].taken = 1;
            g_slots[h].error[0] = '\0';
            return h;
        }
    }
    return -1;
}

// Open a connection from a libpq conninfo string
// ("host=127.0.0.1 user=... password=... dbname=...").
// Returns 0 on success, -1 otherwise.
int pl_open(int h, const char *conninfo) {
    pl_slot *s = slot_of(h);
    if (!s) return -1;
    clear_result(s);
    clear_args(s);
    if (s->conn) {
        PQfinish(s->conn);
        s->conn = NULL;
    }
    s->taken = 1;
    s->error[0] = '\0';
    s->conn = PQconnectdb(conninfo);
    PQsetNoticeProcessor(s->conn, swallow_notice, NULL);
    if (PQstatus(s->conn) != CONNECTION_OK) {
        set_error(s, "could not connect");
        PQfinish(s->conn);
        s->conn = NULL;
        return -1;
    }
    return 0;
}

// Report a refusal the shim never saw: a config the driver would not render
// has no libpq error behind it, and a caller reads every failure the same way.
void pl_fail(int h, const char *message) {
    pl_slot *s = slot_of(h);
    if (!s) return;
    snprintf(s->error, sizeof(s->error), "%s", message);
}

int pl_connected(int h) {
    pl_slot *s = slot_of(h);
    if (!s) return 0;
    return (s->conn != NULL && PQstatus(s->conn) == CONNECTION_OK) ? 1 : 0;
}

// Run a statement that returns no rows. Returns 0 on success, -1 otherwise.
int pl_exec(int h, const char *sql) {
    pl_slot *s = slot_of(h);
    if (!s) return -1;
    if (!s->conn) { snprintf(s->error, sizeof(s->error), "not connected"); return -1; }
    clear_result(s);
    PGresult *r = PQexec(s->conn, sql);
    ExecStatusType st = PQresultStatus(r);
    if (st != PGRES_COMMAND_OK && st != PGRES_TUPLES_OK) {
        set_error(s, "statement failed");
        PQclear(r);
        return -1;
    }
    PQclear(r);
    return 0;
}

int pl_bind(int h, int i, const char *value) {
    pl_slot *s = slot_of(h);
    if (!s) return -1;
    if (i < 0 || i >= PL_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", PL_MAX_PARAMS);
        return -1;
    }
    free(s->args[i]);
    s->args[i] = strdup(value ? value : "");
    if (!s->args[i]) { snprintf(s->error, sizeof(s->error), "out of memory"); return -1; }
    return 0;
}

// Run a query with the `argc` values already bound, holding the rows for
// reading. Returns the row count, or -1 on failure.
int pl_query(int h, const char *sql, int argc) {
    pl_slot *s = slot_of(h);
    if (!s) return -1;
    if (!s->conn) { snprintf(s->error, sizeof(s->error), "not connected"); clear_args(s); return -1; }
    if (argc < 0 || argc > PL_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", PL_MAX_PARAMS);
        clear_args(s);
        return -1;
    }
    clear_result(s);
    const char *vals[PL_MAX_PARAMS];
    for (int i = 0; i < argc; i++) vals[i] = s->args[i] ? s->args[i] : "";
    s->res = PQexecParams(s->conn, sql, argc, NULL, argc > 0 ? vals : NULL, NULL, NULL, 0);
    clear_args(s);
    ExecStatusType st = PQresultStatus(s->res);
    if (st != PGRES_TUPLES_OK && st != PGRES_COMMAND_OK) {
        set_error(s, "query failed");
        clear_result(s);
        return -1;
    }
    return PQntuples(s->res);
}

int pl_rows(int h) {
    pl_slot *s = slot_of(h);
    if (!s || !s->res) return 0;
    return PQntuples(s->res);
}

int pl_cols(int h) {
    pl_slot *s = slot_of(h);
    if (!s || !s->res) return 0;
    return PQnfields(s->res);
}

// A cell as text. Out-of-range coordinates and SQL NULL both read as "", which
// keeps the FFI free of a null string it has no way to represent.
const char *pl_value(int h, int row, int col) {
    pl_slot *s = slot_of(h);
    if (!s || !s->res) return "";
    if (row < 0 || row >= PQntuples(s->res)) return "";
    if (col < 0 || col >= PQnfields(s->res)) return "";
    if (PQgetisnull(s->res, row, col)) return "";
    return PQgetvalue(s->res, row, col);
}

const char *pl_error(int h) {
    pl_slot *s = slot_of(h);
    if (!s) return "no connection slot is available";
    return s->error;
}

const char *pl_version(int h) {
    pl_slot *s = slot_of(h);
    if (!s || !s->conn) return "";
    snprintf(s->version, sizeof(s->version), "%d", PQserverVersion(s->conn));
    return s->version;
}

// Close the connection and free the slot. Slot 0 stays reserved — it is the
// process-wide connection, and closing it means the same as it always did.
void pl_release(int h) {
    pl_slot *s = slot_of(h);
    if (!s) return;
    clear_result(s);
    clear_args(s);
    if (s->conn) {
        PQfinish(s->conn);
        s->conn = NULL;
    }
    s->error[0] = '\0';
    if (h > 0) s->taken = 0;
}

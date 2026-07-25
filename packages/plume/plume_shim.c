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
// Each thread gets its own connection. `http.createServer` runs every handler
// on a worker thread, so one `Db` opened at startup is used from many threads
// at once, and a connection, its live result and its half-bound arguments are
// all state two handlers must not share — sharing them means one request reads
// another's rows. So the slot table is thread-local: a handle names, on each
// thread, that thread's own connection to the same database. What is
// process-wide is which handles exist and what each one connects to, which is
// what makes a `Db` value mean the same thing on every thread.
//
// Parameters are always sent out-of-band (PQexecParams), never pasted into SQL,
// so a document's text cannot end a quote and become statement text.
//
// Build:
//   cc -c plume_shim.c -I$(pg_config --includedir) -o plume_shim.o

#include <libpq-fe.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PL_MAX_CONNECTIONS 64
#define PL_MAX_PARAMS 32
#define PL_MAX_TARGET 1024

// One connection, its live result, and the values waiting for its next query.
// The result belongs to the slot rather than to the shim: two handles used in
// turn would otherwise read each other's rows.
typedef struct {
    PGconn *conn;
    PGresult *res;
    // Which opening of the handle this connection belongs to. A handle that is
    // closed and opened again — a released slot handed out afresh, or a
    // reconnect to a different database — leaves every other thread holding a
    // connection to the old target, and `use` drops it on the generation.
    int generation;
    // The FFI marshals one string per call, so an argument list arrives one
    // pl_bind at a time and is held here until pl_query sends it. Each is
    // copied: the caller's string lives only as long as the call.
    char *args[PL_MAX_PARAMS];
    char error[1024];
    char version[64];
} pl_slot;

// A table of pointers rather than of slots: a slot is more than a kilobyte,
// and 64 of them in thread-local storage would come out of every worker
// thread's stack allocation, which the HTTP server sizes in hundreds of
// kilobytes. A thread pays for the handles it actually uses.
static _Thread_local pl_slot *g_slots[PL_MAX_CONNECTIONS];

// Handle allocation is process-wide, or two threads would hand out the same
// handle and then each believe it owns the connection.
static atomic_int g_taken[PL_MAX_CONNECTIONS];
static atomic_int g_generation[PL_MAX_CONNECTIONS];

// What each handle connects to, so a thread that has never used a handle can
// open its own connection to the same place. Written by pl_open and read by
// every thread that opens afterwards. Nothing locks it: a program connects
// while it is still single-threaded, and the workers only ever read. Opening
// one handle from two threads at once would be a real race, and is not
// something plume does.
static char g_target[PL_MAX_CONNECTIONS][PL_MAX_TARGET];

static pl_slot *slot_of(int h) {
    if (h < 0 || h >= PL_MAX_CONNECTIONS) return NULL;
    if (!g_slots[h]) g_slots[h] = calloc(1, sizeof(pl_slot));
    return g_slots[h];
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

static void close_here(pl_slot *s) {
    clear_result(s);
    clear_args(s);
    if (s->conn) {
        PQfinish(s->conn);
        s->conn = NULL;
    }
}

// This thread's connection to `conninfo`. Returns 0, or -1 with the reason in
// the slot's error.
static int connect_here(pl_slot *s, const char *conninfo) {
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

// The calling thread's slot for `h`, connected. Every entry point goes through
// this: a worker thread that has never touched the handle has no connection of
// its own yet, and opens one here from the target the handle was given.
static pl_slot *use(int h) {
    pl_slot *s = slot_of(h);
    if (!s) return NULL;
    int gen = atomic_load(&g_generation[h]);
    if (s->conn && s->generation != gen) close_here(s);
    if (!s->conn && g_target[h][0] != '\0') {
        if (connect_here(s, g_target[h]) == 0) s->generation = gen;
    }
    return s;
}

// The failure for a call on a handle this thread has no connection for. A
// handle with a target behind it has already failed to open and said why, and
// that reason is worth more than the generic message.
static int no_connection(pl_slot *s, int h) {
    if (g_target[h][0] == '\0') snprintf(s->error, sizeof(s->error), "not connected");
    return -1;
}

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection. The claim is atomic because two threads
// acquiring at once must not be given the same handle.
int pl_acquire(void) {
    for (int h = 1; h < PL_MAX_CONNECTIONS; h++) {
        int free_slot = 0;
        if (atomic_compare_exchange_strong(&g_taken[h], &free_slot, 1)) {
            pl_slot *s = slot_of(h);
            if (s) s->error[0] = '\0';
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
    // Truncating would connect somewhere other than where the caller asked —
    // a dropped `dbname=` still connects — so a target too long to remember is
    // refused instead.
    if (strlen(conninfo) >= PL_MAX_TARGET) {
        snprintf(s->error, sizeof(s->error), "the connection target is longer than %d bytes", PL_MAX_TARGET - 1);
        return -1;
    }
    close_here(s);
    s->error[0] = '\0';
    atomic_store(&g_taken[h], 1);
    snprintf(g_target[h], PL_MAX_TARGET, "%s", conninfo);
    s->generation = atomic_fetch_add(&g_generation[h], 1) + 1;
    if (connect_here(s, conninfo) != 0) {
        // A target that could not be connected is not remembered: no worker
        // should spend a request rediscovering the same failure.
        g_target[h][0] = '\0';
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
    pl_slot *s = use(h);
    if (!s) return 0;
    return (s->conn != NULL && PQstatus(s->conn) == CONNECTION_OK) ? 1 : 0;
}

// Run a statement that returns no rows. Returns 0 on success, -1 otherwise.
int pl_exec(int h, const char *sql) {
    pl_slot *s = use(h);
    if (!s) return -1;
    if (!s->conn) return no_connection(s, h);
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
    pl_slot *s = use(h);
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
    pl_slot *s = use(h);
    if (!s) return -1;
    if (!s->conn) { clear_args(s); return no_connection(s, h); }
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
//
// Reading the result needs no `use`: the rows are this thread's own, held from
// this thread's last query, and a thread that has not run one has none.
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
    pl_slot *s = use(h);
    if (!s || !s->conn) return "";
    snprintf(s->version, sizeof(s->version), "%d", PQserverVersion(s->conn));
    return s->version;
}

// Close the connection and free the slot. Slot 0 stays reserved — it is the
// process-wide connection, and closing it means the same as it always did.
//
// This closes the calling thread's connection. Another thread that opened its
// own for the same handle still holds it: a thread's storage is reachable only
// from that thread, and there is no moment at which one thread may safely free
// another's live PGconn. Those connections are closed when the process ends.
// What matters is that the handle is safe to hand out again: forgetting the
// target stops any further thread from opening one, and the generation bump
// makes every thread still holding the old connection drop it at its next
// call rather than talk to the wrong database.
void pl_release(int h) {
    pl_slot *s = slot_of(h);
    if (!s) return;
    close_here(s);
    s->error[0] = '\0';
    g_target[h][0] = '\0';
    atomic_fetch_add(&g_generation[h], 1);
    if (h > 0) atomic_store(&g_taken[h], 0);
}

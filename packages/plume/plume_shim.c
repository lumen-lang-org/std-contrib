// A scalar/string-friendly C surface over libpq, for plume.
//
// libpq deals in connection and result handles, out-parameters, and arrays of
// rows. The Lumen FFI marshals only scalars and C strings, so this shim keeps
// the connection and the most recent result behind globals and exposes the
// row/column reads as plain calls, the way the SQLite shim hides its
// out-pointers.
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

// The one connection and the one live result this shim manages.
static PGconn *g_conn = NULL;
static PGresult *g_res = NULL;
static char g_error[1024];

static void set_error(const char *fallback) {
    const char *m = g_conn ? PQerrorMessage(g_conn) : NULL;
    if (m == NULL || *m == '\0') m = fallback;
    snprintf(g_error, sizeof(g_error), "%s", m);
    // libpq's messages end in a newline; trim it so callers can compose.
    size_t n = strlen(g_error);
    while (n > 0 && (g_error[n - 1] == '\n' || g_error[n - 1] == '\r')) g_error[--n] = '\0';
}

// libpq prints notices ("extension already exists, skipping") to stderr through
// a default handler. A library has no business writing to a caller's stderr —
// and the messages are not errors, so silencing them loses nothing a caller
// could act on. Real failures still arrive through PQerrorMessage.
static void swallow_notice(void *arg, const char *message) {
    (void)arg;
    (void)message;
}

static void clear_result(void) {
    if (g_res) {
        PQclear(g_res);
        g_res = NULL;
    }
}

// Open a connection from a libpq conninfo string
// ("host=127.0.0.1 user=... password=... dbname=...").
// Returns 0 on success, -1 otherwise.
int pl_connect(const char *conninfo) {
    clear_result();
    if (g_conn) {
        PQfinish(g_conn);
        g_conn = NULL;
    }
    g_error[0] = '\0';
    g_conn = PQconnectdb(conninfo);
    PQsetNoticeProcessor(g_conn, swallow_notice, NULL);
    if (PQstatus(g_conn) != CONNECTION_OK) {
        set_error("could not connect");
        PQfinish(g_conn);
        g_conn = NULL;
        return -1;
    }
    return 0;
}

int pl_connected(void) {
    return (g_conn != NULL && PQstatus(g_conn) == CONNECTION_OK) ? 1 : 0;
}

// Run a statement that returns no rows. Returns 0 on success, -1 otherwise.
int pl_exec(const char *sql) {
    if (!g_conn) { snprintf(g_error, sizeof(g_error), "not connected"); return -1; }
    clear_result();
    PGresult *r = PQexec(g_conn, sql);
    ExecStatusType st = PQresultStatus(r);
    if (st != PGRES_COMMAND_OK && st != PGRES_TUPLES_OK) {
        set_error("statement failed");
        PQclear(r);
        return -1;
    }
    PQclear(r);
    return 0;
}

// Run a query with up to four text parameters, holding the rows for reading.
// A parameter given as NULL is not sent; pass "" for an empty string.
// Returns the row count, or -1 on failure.
static int exec_params(const char *sql, int n, const char *const *vals) {
    if (!g_conn) { snprintf(g_error, sizeof(g_error), "not connected"); return -1; }
    clear_result();
    g_res = PQexecParams(g_conn, sql, n, NULL, vals, NULL, NULL, 0);
    ExecStatusType st = PQresultStatus(g_res);
    if (st != PGRES_TUPLES_OK && st != PGRES_COMMAND_OK) {
        set_error("query failed");
        clear_result();
        return -1;
    }
    return PQntuples(g_res);
}

int pl_query0(const char *sql) {
    return exec_params(sql, 0, NULL);
}

int pl_query1(const char *sql, const char *a) {
    const char *vals[1] = { a };
    return exec_params(sql, 1, vals);
}

int pl_query2(const char *sql, const char *a, const char *b) {
    const char *vals[2] = { a, b };
    return exec_params(sql, 2, vals);
}

int pl_query3(const char *sql, const char *a, const char *b, const char *c) {
    const char *vals[3] = { a, b, c };
    return exec_params(sql, 3, vals);
}

int pl_query4(const char *sql, const char *a, const char *b, const char *c, const char *d) {
    const char *vals[4] = { a, b, c, d };
    return exec_params(sql, 4, vals);
}

int pl_query5(const char *sql, const char *a, const char *b, const char *c, const char *d, const char *e) {
    const char *vals[5] = { a, b, c, d, e };
    return exec_params(sql, 5, vals);
}

int pl_rows(void) {
    return g_res ? PQntuples(g_res) : 0;
}

int pl_cols(void) {
    return g_res ? PQnfields(g_res) : 0;
}

// A cell as text. Out-of-range coordinates and SQL NULL both read as "", which
// keeps the FFI free of a null string it has no way to represent.
const char *pl_value(int row, int col) {
    if (!g_res) return "";
    if (row < 0 || row >= PQntuples(g_res)) return "";
    if (col < 0 || col >= PQnfields(g_res)) return "";
    if (PQgetisnull(g_res, row, col)) return "";
    return PQgetvalue(g_res, row, col);
}

const char *pl_error(void) {
    return g_error;
}

const char *pl_version(void) {
    static char buf[64];
    if (!g_conn) return "";
    snprintf(buf, sizeof(buf), "%d", PQserverVersion(g_conn));
    return buf;
}

void pl_close(void) {
    clear_result();
    if (g_conn) {
        PQfinish(g_conn);
        g_conn = NULL;
    }
    g_error[0] = '\0';
}

// A scalar/string-friendly C surface over SQLite, for the plume ORM.
//
// SQLite's API is handle-based and row-callback-driven; the Lumen FFI marshals
// only scalars and C strings. This shim keeps the connection behind a global
// and materialises a result set into memory, so rows are read by coordinate
// the same way the PostgreSQL shim exposes libpq's.
//
// Values are always bound, never pasted into SQL.
//
// Build:
//   cc -c sqlite_shim.c -o sqlite_shim.o

#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static sqlite3 *g_db = NULL;
static char g_error[1024];

// The materialised result: rows x cols of owned strings.
static char **g_cells = NULL;
static int g_rows = 0;
static int g_cols = 0;

static void set_error(const char *fallback) {
    const char *m = g_db ? sqlite3_errmsg(g_db) : NULL;
    if (m == NULL || *m == '\0') m = fallback;
    snprintf(g_error, sizeof(g_error), "%s", m);
}

static void clear_result(void) {
    if (g_cells) {
        for (int i = 0; i < g_rows * g_cols; i++) free(g_cells[i]);
        free(g_cells);
        g_cells = NULL;
    }
    g_rows = 0;
    g_cols = 0;
}

int sq_connect(const char *path) {
    clear_result();
    if (g_db) { sqlite3_close(g_db); g_db = NULL; }
    g_error[0] = '\0';
    if (sqlite3_open(path, &g_db) != SQLITE_OK) {
        set_error("could not open the database");
        sqlite3_close(g_db);
        g_db = NULL;
        return -1;
    }
    return 0;
}

int sq_connected(void) { return g_db != NULL ? 1 : 0; }

int sq_exec(const char *sql) {
    if (!g_db) { snprintf(g_error, sizeof(g_error), "not connected"); return -1; }
    clear_result();
    char *err = NULL;
    if (sqlite3_exec(g_db, sql, NULL, NULL, &err) != SQLITE_OK) {
        snprintf(g_error, sizeof(g_error), "%s", err ? err : "statement failed");
        sqlite3_free(err);
        return -1;
    }
    return 0;
}

// Run a query, binding `a` to the single parameter when one is given, and hold
// every row. Returns the row count, or -1.
static int run_query(const char *sql, const char *a) {
    if (!g_db) { snprintf(g_error, sizeof(g_error), "not connected"); return -1; }
    clear_result();

    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(g_db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_error("could not prepare the statement");
        return -1;
    }
    if (a != NULL && sqlite3_bind_parameter_count(st) >= 1) {
        sqlite3_bind_text(st, 1, a, -1, SQLITE_TRANSIENT);
    }

    int cap = 16;
    g_cols = sqlite3_column_count(st);
    g_cells = (char **)malloc(sizeof(char *) * (size_t)(cap * (g_cols > 0 ? g_cols : 1)));
    if (!g_cells) { sqlite3_finalize(st); snprintf(g_error, sizeof(g_error), "out of memory"); return -1; }

    int rc;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (g_rows >= cap) {
            cap *= 2;
            char **grown = (char **)realloc(g_cells, sizeof(char *) * (size_t)(cap * g_cols));
            if (!grown) { sqlite3_finalize(st); clear_result(); snprintf(g_error, sizeof(g_error), "out of memory"); return -1; }
            g_cells = grown;
        }
        for (int c = 0; c < g_cols; c++) {
            const unsigned char *v = sqlite3_column_text(st, c);
            const char *s = v ? (const char *)v : "";
            g_cells[g_rows * g_cols + c] = strdup(s);
        }
        g_rows++;
    }
    sqlite3_finalize(st);
    if (rc != SQLITE_DONE) {
        set_error("the query failed");
        clear_result();
        return -1;
    }
    return g_rows;
}

int sq_query1(const char *sql, const char *a) { return run_query(sql, a); }
int sq_query0(const char *sql) { return run_query(sql, NULL); }

int sq_rows(void) { return g_rows; }
int sq_cols(void) { return g_cols; }

const char *sq_value(int row, int col) {
    if (row < 0 || row >= g_rows || col < 0 || col >= g_cols) return "";
    const char *v = g_cells[row * g_cols + col];
    return v ? v : "";
}

const char *sq_error(void) { return g_error; }
const char *sq_version(void) { return sqlite3_libversion(); }

void sq_close(void) {
    clear_result();
    if (g_db) { sqlite3_close(g_db); g_db = NULL; }
    g_error[0] = '\0';
}

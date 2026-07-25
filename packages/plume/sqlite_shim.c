// A scalar/string-friendly C surface over SQLite, for the plume ORM.
//
// SQLite's API is handle-based and row-callback-driven; the Lumen FFI marshals
// only scalars and C strings. This shim keeps each connection in a slot named
// by a small integer and materialises that slot's result set into memory, so
// rows are read by coordinate the same way the PostgreSQL shim exposes libpq's.
//
// A fixed table rather than malloc'd handles: the count is a resource limit
// worth having, an out-of-range handle is checked rather than dereferenced,
// and there is nothing to leak. Slot 0 is the process-wide connection, so a
// program that never asks for a second one behaves as it always did.
//
// Values are always bound, never pasted into SQL.
//
// Build:
//   cc -c sqlite_shim.c -o sqlite_shim.o

#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SQ_MAX_CONNECTIONS 64
#define SQ_MAX_PARAMS 32

// One connection, its materialised result (rows x cols of owned strings), and
// the values waiting for its next query. The result belongs to the slot rather
// than to the shim: two handles used in turn would otherwise read each other's
// rows.
typedef struct {
    int taken;
    sqlite3 *db;
    char **cells;
    int rows;
    int cols;
    // The FFI marshals one string per call, so an argument list arrives one
    // sq_bind at a time and is held here until sq_query sends it. Each is
    // copied: the caller's string lives only as long as the call.
    char *args[SQ_MAX_PARAMS];
    char error[1024];
} sq_slot;

static sq_slot g_slots[SQ_MAX_CONNECTIONS];

static sq_slot *slot_of(int h) {
    if (h < 0 || h >= SQ_MAX_CONNECTIONS) return NULL;
    return &g_slots[h];
}

static void set_error(sq_slot *s, const char *fallback) {
    const char *m = s->db ? sqlite3_errmsg(s->db) : NULL;
    if (m == NULL || *m == '\0') m = fallback;
    snprintf(s->error, sizeof(s->error), "%s", m);
}

static void clear_result(sq_slot *s) {
    if (s->cells) {
        for (int i = 0; i < s->rows * s->cols; i++) free(s->cells[i]);
        free(s->cells);
        s->cells = NULL;
    }
    s->rows = 0;
    s->cols = 0;
}

static void clear_args(sq_slot *s) {
    for (int i = 0; i < SQ_MAX_PARAMS; i++) {
        free(s->args[i]);
        s->args[i] = NULL;
    }
}

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection.
int sq_acquire(void) {
    for (int h = 1; h < SQ_MAX_CONNECTIONS; h++) {
        if (!g_slots[h].taken) {
            g_slots[h].taken = 1;
            g_slots[h].error[0] = '\0';
            return h;
        }
    }
    return -1;
}

int sq_open(int h, const char *path) {
    sq_slot *s = slot_of(h);
    if (!s) return -1;
    clear_result(s);
    clear_args(s);
    if (s->db) { sqlite3_close(s->db); s->db = NULL; }
    s->taken = 1;
    s->error[0] = '\0';
    if (sqlite3_open(path, &s->db) != SQLITE_OK) {
        set_error(s, "could not open the database");
        sqlite3_close(s->db);
        s->db = NULL;
        return -1;
    }
    return 0;
}

// Report a refusal the shim never saw: a config the driver would not render
// has no SQLite error behind it, and a caller reads every failure the same way.
void sq_fail(int h, const char *message) {
    sq_slot *s = slot_of(h);
    if (!s) return;
    snprintf(s->error, sizeof(s->error), "%s", message);
}

int sq_connected(int h) {
    sq_slot *s = slot_of(h);
    return (s && s->db) ? 1 : 0;
}

int sq_exec(int h, const char *sql) {
    sq_slot *s = slot_of(h);
    if (!s) return -1;
    if (!s->db) { snprintf(s->error, sizeof(s->error), "not connected"); return -1; }
    clear_result(s);
    char *err = NULL;
    if (sqlite3_exec(s->db, sql, NULL, NULL, &err) != SQLITE_OK) {
        snprintf(s->error, sizeof(s->error), "%s", err ? err : "statement failed");
        sqlite3_free(err);
        return -1;
    }
    return 0;
}

int sq_bind(int h, int i, const char *value) {
    sq_slot *s = slot_of(h);
    if (!s) return -1;
    if (i < 0 || i >= SQ_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", SQ_MAX_PARAMS);
        return -1;
    }
    free(s->args[i]);
    s->args[i] = strdup(value ? value : "");
    if (!s->args[i]) { snprintf(s->error, sizeof(s->error), "out of memory"); return -1; }
    return 0;
}

// Run a query with the `argc` values already bound, holding every row.
// Returns the row count, or -1.
int sq_query(int h, const char *sql, int argc) {
    sq_slot *s = slot_of(h);
    if (!s) return -1;
    if (!s->db) { snprintf(s->error, sizeof(s->error), "not connected"); clear_args(s); return -1; }
    if (argc < 0 || argc > SQ_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", SQ_MAX_PARAMS);
        clear_args(s);
        return -1;
    }
    clear_result(s);

    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(s->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_error(s, "could not prepare the statement");
        clear_args(s);
        return -1;
    }
    // A count that disagrees with the argument list is refused rather than
    // left to bind as NULL, which SQLite would do silently.
    int want = sqlite3_bind_parameter_count(st);
    if (want != argc) {
        snprintf(s->error, sizeof(s->error), "the statement takes %d parameters, %d given", want, argc);
        sqlite3_finalize(st);
        clear_args(s);
        return -1;
    }
    for (int i = 0; i < argc; i++) {
        sqlite3_bind_text(st, i + 1, s->args[i] ? s->args[i] : "", -1, SQLITE_TRANSIENT);
    }
    clear_args(s);

    int cap = 16;
    s->cols = sqlite3_column_count(st);
    s->cells = (char **)malloc(sizeof(char *) * (size_t)(cap * (s->cols > 0 ? s->cols : 1)));
    if (!s->cells) { sqlite3_finalize(st); snprintf(s->error, sizeof(s->error), "out of memory"); return -1; }

    int rc;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (s->rows >= cap) {
            cap *= 2;
            char **grown = (char **)realloc(s->cells, sizeof(char *) * (size_t)(cap * s->cols));
            if (!grown) { sqlite3_finalize(st); clear_result(s); snprintf(s->error, sizeof(s->error), "out of memory"); return -1; }
            s->cells = grown;
        }
        for (int c = 0; c < s->cols; c++) {
            const unsigned char *v = sqlite3_column_text(st, c);
            const char *text = v ? (const char *)v : "";
            s->cells[s->rows * s->cols + c] = strdup(text);
        }
        s->rows++;
    }
    sqlite3_finalize(st);
    if (rc != SQLITE_DONE) {
        set_error(s, "the query failed");
        clear_result(s);
        return -1;
    }
    return s->rows;
}

int sq_rows(int h) {
    sq_slot *s = slot_of(h);
    return s ? s->rows : 0;
}

int sq_cols(int h) {
    sq_slot *s = slot_of(h);
    return s ? s->cols : 0;
}

const char *sq_value(int h, int row, int col) {
    sq_slot *s = slot_of(h);
    if (!s || !s->cells) return "";
    if (row < 0 || row >= s->rows || col < 0 || col >= s->cols) return "";
    const char *v = s->cells[row * s->cols + col];
    return v ? v : "";
}

const char *sq_error(int h) {
    sq_slot *s = slot_of(h);
    if (!s) return "no connection slot is available";
    return s->error;
}

const char *sq_version(void) { return sqlite3_libversion(); }

// Close the connection and free the slot. Slot 0 stays reserved — it is the
// process-wide connection, and closing it means the same as it always did.
void sq_release(int h) {
    sq_slot *s = slot_of(h);
    if (!s) return;
    clear_result(s);
    clear_args(s);
    if (s->db) { sqlite3_close(s->db); s->db = NULL; }
    s->error[0] = '\0';
    if (h > 0) s->taken = 0;
}

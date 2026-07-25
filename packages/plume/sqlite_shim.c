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
// Each thread gets its own connection. `http.createServer` runs every handler
// on a worker thread, so one `Db` opened at startup is used from many threads
// at once, and a connection, its materialised rows and its half-bound
// arguments are all state two handlers must not share — sharing them means one
// request reads another's rows, and two requests growing the same cell array
// corrupt the heap. So the slot table is thread-local: a handle names, on each
// thread, that thread's own connection to the same file. What is process-wide
// is which handles exist and what each one opens, which is what makes a `Db`
// value mean the same thing on every thread.
//
// Values are always bound, never pasted into SQL.
//
// Build:
//   cc -c sqlite_shim.c -o sqlite_shim.o

#include <sqlite3.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SQ_MAX_CONNECTIONS 64
#define SQ_MAX_PARAMS 32
#define SQ_MAX_TARGET 1024

// One SQLite writer holds the database while it writes, and connections on
// other threads are told the database is locked rather than made to wait. Five
// seconds of waiting turns that into what a caller expects — a slower request,
// not a failed one — and is still short enough that a genuine deadlock is
// reported rather than hung on.
#define SQ_BUSY_TIMEOUT_MS 5000

// One connection, its materialised result (rows x cols of owned strings), and
// the values waiting for its next query. The result belongs to the slot rather
// than to the shim: two handles used in turn would otherwise read each other's
// rows.
typedef struct {
    sqlite3 *db;
    char **cells;
    int rows;
    int cols;
    // Which opening of the handle this connection belongs to. A handle that is
    // closed and opened again — a released slot handed out afresh, or a
    // reconnect to a different file — leaves every other thread holding a
    // connection to the old one, and `use` drops it on the generation.
    int generation;
    // The FFI marshals one string per call, so an argument list arrives one
    // sq_bind at a time and is held here until sq_query sends it. Each is
    // copied: the caller's string lives only as long as the call.
    char *args[SQ_MAX_PARAMS];
    char error[1024];
} sq_slot;

// A table of pointers rather than of slots: a slot is more than a kilobyte,
// and 64 of them in thread-local storage would come out of every worker
// thread's stack allocation, which the HTTP server sizes in hundreds of
// kilobytes. A thread pays for the handles it actually uses.
static _Thread_local sq_slot *g_slots[SQ_MAX_CONNECTIONS];

// Handle allocation is process-wide, or two threads would hand out the same
// handle and then each believe it owns the connection.
static atomic_int g_taken[SQ_MAX_CONNECTIONS];
static atomic_int g_generation[SQ_MAX_CONNECTIONS];

// What each handle opens, so a thread that has never used a handle can open
// its own connection to the same file. Written by sq_open and read by every
// thread that opens afterwards. Nothing locks it: a program connects while it
// is still single-threaded, and the workers only ever read. Opening one handle
// from two threads at once would be a real race, and is not something plume
// does.
static char g_target[SQ_MAX_CONNECTIONS][SQ_MAX_TARGET];

static sq_slot *slot_of(int h) {
    if (h < 0 || h >= SQ_MAX_CONNECTIONS) return NULL;
    if (!g_slots[h]) g_slots[h] = calloc(1, sizeof(sq_slot));
    return g_slots[h];
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

static void close_here(sq_slot *s) {
    clear_result(s);
    clear_args(s);
    if (s->db) { sqlite3_close(s->db); s->db = NULL; }
}

// This thread's connection to `path`. Returns 0, or -1 with the reason in the
// slot's error.
static int connect_here(sq_slot *s, const char *path) {
    if (sqlite3_open(path, &s->db) != SQLITE_OK) {
        set_error(s, "could not open the database");
        sqlite3_close(s->db);
        s->db = NULL;
        return -1;
    }
    sqlite3_busy_timeout(s->db, SQ_BUSY_TIMEOUT_MS);
    return 0;
}

// The calling thread's slot for `h`, connected. Every entry point goes through
// this: a worker thread that has never touched the handle has no connection of
// its own yet, and opens one here to the file the handle was given.
static sq_slot *use(int h) {
    sq_slot *s = slot_of(h);
    if (!s) return NULL;
    int gen = atomic_load(&g_generation[h]);
    if (s->db && s->generation != gen) close_here(s);
    if (!s->db && g_target[h][0] != '\0') {
        if (connect_here(s, g_target[h]) == 0) s->generation = gen;
    }
    return s;
}

// The failure for a call on a handle this thread has no connection for. A
// handle with a target behind it has already failed to open and said why, and
// that reason is worth more than the generic message.
static int no_connection(sq_slot *s, int h) {
    if (g_target[h][0] == '\0') snprintf(s->error, sizeof(s->error), "not connected");
    return -1;
}

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection. The claim is atomic because two threads
// acquiring at once must not be given the same handle.
int sq_acquire(void) {
    for (int h = 1; h < SQ_MAX_CONNECTIONS; h++) {
        int free_slot = 0;
        if (atomic_compare_exchange_strong(&g_taken[h], &free_slot, 1)) {
            sq_slot *s = slot_of(h);
            if (s) s->error[0] = '\0';
            return h;
        }
    }
    return -1;
}

int sq_open(int h, const char *path) {
    sq_slot *s = slot_of(h);
    if (!s) return -1;
    // Truncating would open a different file from the one the caller named, so
    // a path too long to remember is refused instead.
    if (strlen(path) >= SQ_MAX_TARGET) {
        snprintf(s->error, sizeof(s->error), "the database path is longer than %d bytes", SQ_MAX_TARGET - 1);
        return -1;
    }
    close_here(s);
    s->error[0] = '\0';
    atomic_store(&g_taken[h], 1);
    snprintf(g_target[h], SQ_MAX_TARGET, "%s", path);
    s->generation = atomic_fetch_add(&g_generation[h], 1) + 1;
    if (connect_here(s, path) != 0) {
        // A path that could not be opened is not remembered: no worker should
        // spend a request rediscovering the same failure.
        g_target[h][0] = '\0';
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
    sq_slot *s = use(h);
    return (s && s->db) ? 1 : 0;
}

int sq_exec(int h, const char *sql) {
    sq_slot *s = use(h);
    if (!s) return -1;
    if (!s->db) return no_connection(s, h);
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
    sq_slot *s = use(h);
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
    sq_slot *s = use(h);
    if (!s) return -1;
    if (!s->db) { clear_args(s); return no_connection(s, h); }
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

// Reading the result needs no `use`: the rows are this thread's own, held from
// this thread's last query, and a thread that has not run one has none.
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
//
// This closes the calling thread's connection. Another thread that opened its
// own for the same handle still holds it: a thread's storage is reachable only
// from that thread, and there is no moment at which one thread may safely
// close another's live sqlite3. Those connections are closed when the process
// ends. What matters is that the handle is safe to hand out again: forgetting
// the target stops any further thread from opening one, and the generation
// bump makes every thread still holding the old connection drop it at its next
// call rather than read the wrong file.
void sq_release(int h) {
    sq_slot *s = slot_of(h);
    if (!s) return;
    close_here(s);
    s->error[0] = '\0';
    g_target[h][0] = '\0';
    atomic_fetch_add(&g_generation[h], 1);
    if (h > 0) atomic_store(&g_taken[h], 0);
}

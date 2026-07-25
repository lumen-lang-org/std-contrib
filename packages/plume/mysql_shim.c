// The C side of the MySQL and MariaDB driver.
//
// Like the other two shims this materialises a whole result set into strings
// before handing it back, because the Lumen side reads it by row and column
// after the statement has been closed.
//
// A connection lives in a slot named by a small integer, and each slot owns
// its own result set: two handles used in turn must not read each other's
// rows. A fixed table rather than malloc'd handles keeps the count a resource
// limit, makes an out-of-range handle a check rather than a dereference, and
// leaves nothing to leak. Slot 0 is the process-wide connection.
//
// Each thread gets its own connection. `http.createServer` runs every handler
// on a worker thread, so one `Db` opened at startup is used from many threads
// at once, and a connection, its materialised rows and its half-bound
// arguments are all state two handlers must not share — sharing them means one
// request reads another's rows, and a MYSQL used from two threads at once is
// undefined besides. So the slot table is thread-local: a handle names, on
// each thread, that thread's own connection to the same server. What is
// process-wide is which handles exist and what each one connects to, which is
// what makes a `Db` value mean the same thing on every thread.

#include <mysql.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MY_MAX_CONNECTIONS 64
#define MY_MAX_PARAMS 32
#define MY_MAX_TARGET 1024

typedef struct {
    MYSQL *conn;
    char **cells;
    int rows;
    int cols;
    // Which opening of the handle this connection belongs to. A handle that is
    // closed and opened again — a released slot handed out afresh, or a
    // reconnect to a different database — leaves every other thread holding a
    // connection to the old target, and `use` drops it on the generation.
    int generation;
    // The FFI marshals one string per call, so an argument list arrives one
    // my_bind at a time and is held here until my_query sends it. Each is
    // copied: the caller's string lives only as long as the call, and
    // MYSQL_BIND wants the length beside the buffer.
    char *args[MY_MAX_PARAMS];
    unsigned long arglen[MY_MAX_PARAMS];
    char error[512];
} my_slot;

// A table of pointers rather than of slots: a slot is most of a kilobyte, and
// 64 of them in thread-local storage would come out of every worker thread's
// stack allocation, which the HTTP server sizes in hundreds of kilobytes. A
// thread pays for the handles it actually uses.
static _Thread_local my_slot *g_slots[MY_MAX_CONNECTIONS];

// Handle allocation is process-wide, or two threads would hand out the same
// handle and then each believe it owns the connection.
static atomic_int g_taken[MY_MAX_CONNECTIONS];
static atomic_int g_generation[MY_MAX_CONNECTIONS];

// What each handle connects to, so a thread that has never used a handle can
// open its own connection to the same place. Written by my_open and read by
// every thread that opens afterwards. Nothing locks it: a program connects
// while it is still single-threaded, and the workers only ever read. Opening
// one handle from two threads at once would be a real race, and is not
// something plume does.
static char g_target[MY_MAX_CONNECTIONS][MY_MAX_TARGET];

static my_slot *slot_of(int h) {
    if (h < 0 || h >= MY_MAX_CONNECTIONS) return NULL;
    if (!g_slots[h]) g_slots[h] = calloc(1, sizeof(my_slot));
    return g_slots[h];
}

static void clear_result(my_slot *s) {
    if (s->cells) {
        for (int i = 0; i < s->rows * s->cols; i++) free(s->cells[i]);
        free(s->cells);
        s->cells = NULL;
    }
    s->rows = 0;
    s->cols = 0;
}

static void clear_args(my_slot *s) {
    for (int i = 0; i < MY_MAX_PARAMS; i++) {
        free(s->args[i]);
        s->args[i] = NULL;
        s->arglen[i] = 0;
    }
}

// The reason the last call failed. With no connection: a handle with a target
// behind it has already failed to open and said why, and that reason is worth
// more than the generic message.
static void note_error(my_slot *s, int h) {
    if (s->conn) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_error(s->conn));
    } else if (g_target[h][0] == '\0') {
        snprintf(s->error, sizeof(s->error), "not connected");
    }
}

static void close_here(my_slot *s) {
    clear_result(s);
    clear_args(s);
    if (s->conn) {
        mysql_close(s->conn);
        s->conn = NULL;
    }
}

// One value of the target list, into `out`. Either bare, ending at the next
// space, or wrapped in single quotes with a backslash escaping the next
// character — libpq's convention, which the driver renders every value in.
// Without it a password carrying a space would end here and the rest of the
// list would be read as further keys, so the connection would quietly be made
// somewhere else.
static const char *read_value(const char *p, char *out, size_t cap) {
    size_t n = 0;
    if (*p == '\'') {
        p++;
        while (*p && *p != '\'') {
            if (*p == '\\' && p[1]) p++;
            if (n + 1 < cap) out[n++] = *p;
            p++;
        }
        if (*p == '\'') p++;
    } else {
        while (*p && *p != ' ') {
            if (n + 1 < cap) out[n++] = *p;
            p++;
        }
    }
    out[n] = '\0';
    return p;
}

// `target` is a URL-ish list of key=value pairs, matching what the other
// drivers take rather than what MySQL's own tools take:
//   "host='127.0.0.1' port='3306' user='root' dbname='lumentest'"
static void parse_target(const char *target, char *host, char *user,
                         char *pass, char *db, unsigned int *port,
                         char *socket) {
    host[0] = user[0] = pass[0] = db[0] = socket[0] = '\0';
    *port = 3306;
    const char *p = target;
    while (*p) {
        while (*p == ' ') p++;
        if (!*p) break;
        const char *key = p;
        while (*p && *p != '=' && *p != ' ') p++;
        size_t klen = (size_t)(p - key);
        if (*p != '=') { while (*p && *p != ' ') p++; continue; }
        p++;

        char val[256];
        p = read_value(p, val, sizeof(val));

        if (klen == 4 && strncmp(key, "host", 4) == 0) {
            snprintf(host, 256, "%s", val);
        } else if (klen == 4 && strncmp(key, "user", 4) == 0) {
            snprintf(user, 256, "%s", val);
        } else if (klen == 8 && strncmp(key, "password", 8) == 0) {
            snprintf(pass, 256, "%s", val);
        } else if ((klen == 6 && strncmp(key, "dbname", 6) == 0) ||
                   (klen == 2 && strncmp(key, "db", 2) == 0)) {
            snprintf(db, 256, "%s", val);
        } else if (klen == 4 && strncmp(key, "port", 4) == 0) {
            *port = (unsigned int)atoi(val);
        } else if (klen == 6 && strncmp(key, "socket", 6) == 0) {
            snprintf(socket, 256, "%s", val);
        }
    }
    if (host[0] == '\0') snprintf(host, 256, "127.0.0.1");
}

// This thread's connection to `target`. Returns 0, or 1 with the reason in the
// slot's error.
static int connect_here(my_slot *s, int h, const char *target) {
    char host[256], user[256], pass[256], db[256], socket[256];
    unsigned int port;
    parse_target(target, host, user, pass, db, &port, socket);

    // The client library's own per-thread state, which mysql_init would
    // otherwise set up as a side effect of the first connection made on this
    // thread. Asking for it plainly costs nothing and is what the library
    // documents for a thread that connects.
    mysql_thread_init();
    s->conn = mysql_init(NULL);
    if (!s->conn) {
        snprintf(s->error, sizeof(s->error), "mysql_init failed");
        return 1;
    }
    // Multi-statement is off deliberately: plume sends one statement at a
    // time, and leaving it off means a semicolon smuggled into a value cannot
    // become a second statement.
    if (!mysql_real_connect(s->conn, host, user[0] ? user : NULL,
                            pass[0] ? pass : NULL, db[0] ? db : NULL, port,
                            socket[0] ? socket : NULL, 0)) {
        note_error(s, h);
        mysql_close(s->conn);
        s->conn = NULL;
        return 1;
    }
    mysql_set_character_set(s->conn, "utf8mb4");
    s->error[0] = '\0';
    return 0;
}

// The calling thread's slot for `h`, connected. Every entry point goes through
// this: a worker thread that has never touched the handle has no connection of
// its own yet, and opens one here from the target the handle was given.
static my_slot *use(int h) {
    my_slot *s = slot_of(h);
    if (!s) return NULL;
    int gen = atomic_load(&g_generation[h]);
    if (s->conn && s->generation != gen) close_here(s);
    if (!s->conn && g_target[h][0] != '\0') {
        if (connect_here(s, h, g_target[h]) == 0) s->generation = gen;
    }
    return s;
}

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection. The claim is atomic because two threads
// acquiring at once must not be given the same handle.
int my_acquire(void) {
    for (int h = 1; h < MY_MAX_CONNECTIONS; h++) {
        int free_slot = 0;
        if (atomic_compare_exchange_strong(&g_taken[h], &free_slot, 1)) {
            my_slot *s = slot_of(h);
            if (s) s->error[0] = '\0';
            return h;
        }
    }
    return -1;
}

int my_open(int h, const char *target) {
    my_slot *s = slot_of(h);
    if (!s) return 1;
    // Truncating would connect somewhere other than where the caller asked —
    // a dropped `dbname=` still connects — so a target too long to remember is
    // refused instead.
    if (strlen(target) >= MY_MAX_TARGET) {
        snprintf(s->error, sizeof(s->error), "the connection target is longer than %d bytes", MY_MAX_TARGET - 1);
        return 1;
    }
    // The client library's process-wide setup, which mysql_init would
    // otherwise do implicitly on whichever thread connected first — and doing
    // it implicitly is only safe while there is one thread. A program connects
    // before it serves, so here it is single-threaded and explicit.
    mysql_library_init(0, NULL, NULL);
    close_here(s);
    s->error[0] = '\0';
    atomic_store(&g_taken[h], 1);
    snprintf(g_target[h], MY_MAX_TARGET, "%s", target);
    s->generation = atomic_fetch_add(&g_generation[h], 1) + 1;
    if (connect_here(s, h, target) != 0) {
        // A target that could not be connected is not remembered: no worker
        // should spend a request rediscovering the same failure.
        g_target[h][0] = '\0';
        return 1;
    }
    return 0;
}

// Report a refusal the shim never saw: a config the driver would not render
// has no MySQL error behind it, and a caller reads every failure the same way.
void my_fail(int h, const char *message) {
    my_slot *s = slot_of(h);
    if (!s) return;
    snprintf(s->error, sizeof(s->error), "%s", message);
}

int my_connected(int h) {
    my_slot *s = use(h);
    return (s && s->conn) ? 1 : 0;
}

int my_exec(int h, const char *sql) {
    my_slot *s = use(h);
    if (!s) return 1;
    clear_result(s);
    if (!s->conn) { note_error(s, h); return 1; }
    if (mysql_query(s->conn, sql) != 0) { note_error(s, h); return 1; }
    // A statement may still carry a result set (SELECT run through exec);
    // draining it keeps the connection usable.
    MYSQL_RES *res = mysql_store_result(s->conn);
    if (res) mysql_free_result(res);
    s->error[0] = '\0';
    return 0;
}

static int store(my_slot *s, MYSQL_STMT *stmt);

int my_bind(int h, int i, const char *value) {
    my_slot *s = use(h);
    if (!s) return -1;
    if (i < 0 || i >= MY_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", MY_MAX_PARAMS);
        return -1;
    }
    const char *v = value ? value : "";
    size_t n = strlen(v);
    free(s->args[i]);
    s->args[i] = malloc(n + 1);
    if (!s->args[i]) { snprintf(s->error, sizeof(s->error), "out of memory"); s->arglen[i] = 0; return -1; }
    memcpy(s->args[i], v, n + 1);
    s->arglen[i] = (unsigned long)n;
    return 0;
}

// No parameters: the plain text protocol is enough, and it accepts statements
// the prepared protocol will not.
static int query_text(my_slot *s, int h, const char *sql) {
    clear_result(s);
    if (!s->conn) { note_error(s, h); return -1; }
    if (mysql_query(s->conn, sql) != 0) { note_error(s, h); return -1; }
    MYSQL_RES *res = mysql_store_result(s->conn);
    if (!res) {
        if (mysql_field_count(s->conn) != 0) { note_error(s, h); return -1; }
        s->error[0] = '\0';
        return 0;
    }
    s->cols = (int)mysql_num_fields(res);
    s->rows = (int)mysql_num_rows(res);
    if (s->rows > 0 && s->cols > 0) {
        s->cells = calloc((size_t)(s->rows * s->cols), sizeof(char *));
        MYSQL_ROW row;
        int r = 0;
        while ((row = mysql_fetch_row(res)) != NULL && r < s->rows) {
            unsigned long *lengths = mysql_fetch_lengths(res);
            for (int c = 0; c < s->cols; c++) {
                if (row[c]) {
                    size_t n = (size_t)lengths[c];
                    char *copy = malloc(n + 1);
                    memcpy(copy, row[c], n);
                    copy[n] = '\0';
                    s->cells[r * s->cols + c] = copy;
                } else {
                    s->cells[r * s->cols + c] = strdup("");
                }
            }
            r++;
        }
    }
    mysql_free_result(res);
    s->error[0] = '\0';
    return s->rows;
}

// Every value bound in its own place, through a prepared statement so none is
// ever pasted into SQL. MySQL takes its `?` in order and has no numbering, so
// parameter i is argument i.
int my_query(int h, const char *sql, int argc) {
    my_slot *s = use(h);
    if (!s) return -1;
    if (argc < 0 || argc > MY_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", MY_MAX_PARAMS);
        clear_args(s);
        return -1;
    }
    if (argc == 0) { clear_args(s); return query_text(s, h, sql); }

    clear_result(s);
    if (!s->conn) { note_error(s, h); clear_args(s); return -1; }

    MYSQL_STMT *stmt = mysql_stmt_init(s->conn);
    if (!stmt) { note_error(s, h); clear_args(s); return -1; }
    if (mysql_stmt_prepare(stmt, sql, (unsigned long)strlen(sql)) != 0) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_stmt_error(stmt));
        mysql_stmt_close(stmt);
        clear_args(s);
        return -1;
    }

    // A count that disagrees with the argument list is refused: MySQL would
    // otherwise fail with a message about the wire protocol rather than about
    // the statement.
    unsigned long count = mysql_stmt_param_count(stmt);
    if (count != (unsigned long)argc) {
        snprintf(s->error, sizeof(s->error), "the statement takes %lu parameters, %d given", count, argc);
        mysql_stmt_close(stmt);
        clear_args(s);
        return -1;
    }

    MYSQL_BIND *binds = calloc(count, sizeof(MYSQL_BIND));
    for (int i = 0; i < argc; i++) {
        binds[i].buffer_type = MYSQL_TYPE_STRING;
        binds[i].buffer = (void *)(s->args[i] ? s->args[i] : "");
        binds[i].buffer_length = s->arglen[i];
        binds[i].length = &s->arglen[i];
    }
    if (mysql_stmt_bind_param(stmt, binds) != 0) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_stmt_error(stmt));
        free(binds);
        mysql_stmt_close(stmt);
        clear_args(s);
        return -1;
    }

    if (mysql_stmt_execute(stmt) != 0) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_stmt_error(stmt));
        free(binds);
        mysql_stmt_close(stmt);
        clear_args(s);
        return -1;
    }

    int rows = store(s, stmt);
    free(binds);
    mysql_stmt_close(stmt);
    clear_args(s);
    if (rows < 0) return -1;
    s->error[0] = '\0';
    return rows;
}

// Pull a prepared statement's result set into the slot's cells as strings.
// Every column is fetched as text, because plume reads JSON documents and
// counts out of these and never needs a native type.
static int store(my_slot *s, MYSQL_STMT *stmt) {
    MYSQL_RES *meta = mysql_stmt_result_metadata(stmt);
    if (!meta) {
        // A statement with no result set: an INSERT or an UPDATE.
        s->rows = 0;
        s->cols = 0;
        return 0;
    }
    s->cols = (int)mysql_num_fields(meta);
    mysql_free_result(meta);

    if (mysql_stmt_store_result(stmt) != 0) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_stmt_error(stmt));
        s->cols = 0;
        return -1;
    }
    s->rows = (int)mysql_stmt_num_rows(stmt);
    if (s->rows == 0 || s->cols == 0) return s->rows;

    s->cells = calloc((size_t)(s->rows * s->cols), sizeof(char *));

    MYSQL_BIND *out = calloc((size_t)s->cols, sizeof(MYSQL_BIND));
    unsigned long *lengths = calloc((size_t)s->cols, sizeof(unsigned long));
    my_bool *is_null = calloc((size_t)s->cols, sizeof(my_bool));
    my_bool *error = calloc((size_t)s->cols, sizeof(my_bool));
    // A zero-length buffer makes the fetch report the true length in
    // `lengths` without copying, and the column is then re-fetched into a
    // buffer of exactly that size.
    for (int c = 0; c < s->cols; c++) {
        out[c].buffer_type = MYSQL_TYPE_STRING;
        out[c].buffer = NULL;
        out[c].buffer_length = 0;
        out[c].length = &lengths[c];
        out[c].is_null = &is_null[c];
        out[c].error = &error[c];
    }
    mysql_stmt_bind_result(stmt, out);

    int r = 0;
    while (r < s->rows) {
        int rc = mysql_stmt_fetch(stmt);
        if (rc == MYSQL_NO_DATA) break;
        if (rc != 0 && rc != MYSQL_DATA_TRUNCATED) break;
        for (int c = 0; c < s->cols; c++) {
            if (is_null[c]) {
                s->cells[r * s->cols + c] = strdup("");
                continue;
            }
            size_t n = (size_t)lengths[c];
            char *buf = malloc(n + 1);
            MYSQL_BIND one;
            memset(&one, 0, sizeof(one));
            one.buffer_type = MYSQL_TYPE_STRING;
            one.buffer = buf;
            one.buffer_length = (unsigned long)n;
            one.length = &lengths[c];
            one.is_null = &is_null[c];
            mysql_stmt_fetch_column(stmt, &one, (unsigned int)c, 0);
            buf[n] = '\0';
            s->cells[r * s->cols + c] = buf;
        }
        r++;
    }
    s->rows = r;

    free(out);
    free(lengths);
    free(is_null);
    free(error);
    return s->rows;
}

// Reading the result needs no `use`: the rows are this thread's own, held from
// this thread's last query, and a thread that has not run one has none.
int my_rows(int h) {
    my_slot *s = slot_of(h);
    return s ? s->rows : 0;
}

const char *my_value(int h, int row, int col) {
    my_slot *s = slot_of(h);
    if (!s || !s->cells) return "";
    if (row < 0 || col < 0 || row >= s->rows || col >= s->cols) return "";
    const char *v = s->cells[row * s->cols + col];
    return v ? v : "";
}

const char *my_error(int h) {
    my_slot *s = slot_of(h);
    if (!s) return "no connection slot is available";
    return s->error;
}

const char *my_version(int h) {
    my_slot *s = use(h);
    if (!s || !s->conn) return "";
    return mysql_get_server_info(s->conn);
}

// Close the connection and free the slot. Slot 0 stays reserved — it is the
// process-wide connection, and closing it means the same as it always did.
//
// This closes the calling thread's connection. Another thread that opened its
// own for the same handle still holds it: a thread's storage is reachable only
// from that thread, and there is no moment at which one thread may safely
// close another's live MYSQL. Those connections are closed when the process
// ends. What matters is that the handle is safe to hand out again: forgetting
// the target stops any further thread from opening one, and the generation
// bump makes every thread still holding the old connection drop it at its next
// call rather than talk to the wrong database.
void my_release(int h) {
    my_slot *s = slot_of(h);
    if (!s) return;
    close_here(s);
    s->error[0] = '\0';
    g_target[h][0] = '\0';
    atomic_fetch_add(&g_generation[h], 1);
    if (h > 0) atomic_store(&g_taken[h], 0);
}

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

#include <mysql.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MY_MAX_CONNECTIONS 64
#define MY_MAX_PARAMS 32

typedef struct {
    int taken;
    MYSQL *conn;
    char **cells;
    int rows;
    int cols;
    // The FFI marshals one string per call, so an argument list arrives one
    // my_bind at a time and is held here until my_query sends it. Each is
    // copied: the caller's string lives only as long as the call, and
    // MYSQL_BIND wants the length beside the buffer.
    char *args[MY_MAX_PARAMS];
    unsigned long arglen[MY_MAX_PARAMS];
    char error[512];
} my_slot;

static my_slot g_slots[MY_MAX_CONNECTIONS];

static my_slot *slot_of(int h) {
    if (h < 0 || h >= MY_MAX_CONNECTIONS) return NULL;
    return &g_slots[h];
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

static void note_error(my_slot *s) {
    if (s->conn) {
        snprintf(s->error, sizeof(s->error), "%s", mysql_error(s->conn));
    } else {
        snprintf(s->error, sizeof(s->error), "not connected");
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

// A free slot, or -1 when all are in use. Slot 0 is never handed out: it is
// the process-wide connection.
int my_acquire(void) {
    for (int h = 1; h < MY_MAX_CONNECTIONS; h++) {
        if (!g_slots[h].taken) {
            g_slots[h].taken = 1;
            g_slots[h].error[0] = '\0';
            return h;
        }
    }
    return -1;
}

int my_open(int h, const char *target) {
    my_slot *s = slot_of(h);
    if (!s) return 1;
    char host[256], user[256], pass[256], db[256], socket[256];
    unsigned int port;
    parse_target(target, host, user, pass, db, &port, socket);

    clear_result(s);
    clear_args(s);
    if (s->conn) { mysql_close(s->conn); s->conn = NULL; }
    s->taken = 1;
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
        note_error(s);
        mysql_close(s->conn);
        s->conn = NULL;
        return 1;
    }
    mysql_set_character_set(s->conn, "utf8mb4");
    s->error[0] = '\0';
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
    my_slot *s = slot_of(h);
    return (s && s->conn) ? 1 : 0;
}

int my_exec(int h, const char *sql) {
    my_slot *s = slot_of(h);
    if (!s) return 1;
    clear_result(s);
    if (!s->conn) { note_error(s); return 1; }
    if (mysql_query(s->conn, sql) != 0) { note_error(s); return 1; }
    // A statement may still carry a result set (SELECT run through exec);
    // draining it keeps the connection usable.
    MYSQL_RES *res = mysql_store_result(s->conn);
    if (res) mysql_free_result(res);
    s->error[0] = '\0';
    return 0;
}

static int store(my_slot *s, MYSQL_STMT *stmt);

int my_bind(int h, int i, const char *value) {
    my_slot *s = slot_of(h);
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
static int query_text(my_slot *s, const char *sql) {
    clear_result(s);
    if (!s->conn) { note_error(s); return -1; }
    if (mysql_query(s->conn, sql) != 0) { note_error(s); return -1; }
    MYSQL_RES *res = mysql_store_result(s->conn);
    if (!res) {
        if (mysql_field_count(s->conn) != 0) { note_error(s); return -1; }
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
    my_slot *s = slot_of(h);
    if (!s) return -1;
    if (argc < 0 || argc > MY_MAX_PARAMS) {
        snprintf(s->error, sizeof(s->error), "a statement may take at most %d parameters", MY_MAX_PARAMS);
        clear_args(s);
        return -1;
    }
    if (argc == 0) { clear_args(s); return query_text(s, sql); }

    clear_result(s);
    if (!s->conn) { note_error(s); clear_args(s); return -1; }

    MYSQL_STMT *stmt = mysql_stmt_init(s->conn);
    if (!stmt) { note_error(s); clear_args(s); return -1; }
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
    my_slot *s = slot_of(h);
    if (!s || !s->conn) return "";
    return mysql_get_server_info(s->conn);
}

// Close the connection and free the slot. Slot 0 stays reserved — it is the
// process-wide connection, and closing it means the same as it always did.
void my_release(int h) {
    my_slot *s = slot_of(h);
    if (!s) return;
    clear_result(s);
    clear_args(s);
    if (s->conn) {
        mysql_close(s->conn);
        s->conn = NULL;
    }
    s->error[0] = '\0';
    if (h > 0) s->taken = 0;
}

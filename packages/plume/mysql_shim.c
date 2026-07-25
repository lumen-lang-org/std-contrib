// The C side of the MySQL and MariaDB driver.
//
// Like the other two shims this materialises a whole result set into strings
// before handing it back, because the Lumen side reads it by row and column
// after the statement has been closed.
//
// One connection per process, held here. That is what plume's driver type
// asks for, and it keeps the FFI surface to plain arguments and return values.

#include <mysql.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static MYSQL *g_conn = NULL;
static char **g_cells = NULL;
static int g_rows = 0;
static int g_cols = 0;
static char g_error[512] = {0};

static void clear_result(void) {
    if (g_cells) {
        for (int i = 0; i < g_rows * g_cols; i++) free(g_cells[i]);
        free(g_cells);
        g_cells = NULL;
    }
    g_rows = 0;
    g_cols = 0;
}

static void note_error(void) {
    if (g_conn) {
        snprintf(g_error, sizeof(g_error), "%s", mysql_error(g_conn));
    } else {
        snprintf(g_error, sizeof(g_error), "not connected");
    }
}

// `target` is a URL-ish list of key=value pairs, matching what the other
// drivers take rather than what MySQL's own tools take:
//   "host=127.0.0.1 port=3306 user=root password=lumen dbname=lumentest"
static void parse_target(const char *target, char *host, char *user,
                         char *pass, char *db, unsigned int *port,
                         char *socket) {
    host[0] = user[0] = pass[0] = db[0] = socket[0] = '\0';
    *port = 3306;
    const char *p = target;
    while (*p) {
        while (*p == ' ') p++;
        const char *key = p;
        while (*p && *p != '=' && *p != ' ') p++;
        size_t klen = (size_t)(p - key);
        if (*p != '=') { while (*p && *p != ' ') p++; continue; }
        p++;
        const char *val = p;
        while (*p && *p != ' ') p++;
        size_t vlen = (size_t)(p - val);
        if (vlen > 255) vlen = 255;

        if (klen == 4 && strncmp(key, "host", 4) == 0) {
            memcpy(host, val, vlen); host[vlen] = '\0';
        } else if (klen == 4 && strncmp(key, "user", 4) == 0) {
            memcpy(user, val, vlen); user[vlen] = '\0';
        } else if (klen == 8 && strncmp(key, "password", 8) == 0) {
            memcpy(pass, val, vlen); pass[vlen] = '\0';
        } else if ((klen == 6 && strncmp(key, "dbname", 6) == 0) ||
                   (klen == 2 && strncmp(key, "db", 2) == 0)) {
            memcpy(db, val, vlen); db[vlen] = '\0';
        } else if (klen == 4 && strncmp(key, "port", 4) == 0) {
            char buf[16];
            size_t n = vlen < 15 ? vlen : 15;
            memcpy(buf, val, n); buf[n] = '\0';
            *port = (unsigned int)atoi(buf);
        } else if (klen == 6 && strncmp(key, "socket", 6) == 0) {
            memcpy(socket, val, vlen); socket[vlen] = '\0';
        }
    }
    if (host[0] == '\0') snprintf(host, 256, "127.0.0.1");
}

int my_connect(const char *target) {
    char host[256], user[256], pass[256], db[256], socket[256];
    unsigned int port;
    parse_target(target, host, user, pass, db, &port, socket);

    if (g_conn) { mysql_close(g_conn); g_conn = NULL; }
    g_conn = mysql_init(NULL);
    if (!g_conn) {
        snprintf(g_error, sizeof(g_error), "mysql_init failed");
        return 1;
    }
    // Multi-statement is off deliberately: plume sends one statement at a
    // time, and leaving it off means a semicolon smuggled into a value cannot
    // become a second statement.
    if (!mysql_real_connect(g_conn, host, user[0] ? user : NULL,
                            pass[0] ? pass : NULL, db[0] ? db : NULL, port,
                            socket[0] ? socket : NULL, 0)) {
        note_error();
        mysql_close(g_conn);
        g_conn = NULL;
        return 1;
    }
    mysql_set_character_set(g_conn, "utf8mb4");
    g_error[0] = '\0';
    return 0;
}

int my_connected(void) { return g_conn != NULL ? 1 : 0; }

int my_exec(const char *sql) {
    clear_result();
    if (!g_conn) { note_error(); return 1; }
    if (mysql_query(g_conn, sql) != 0) { note_error(); return 1; }
    // A statement may still carry a result set (SELECT run through exec);
    // draining it keeps the connection usable.
    MYSQL_RES *res = mysql_store_result(g_conn);
    if (res) mysql_free_result(res);
    g_error[0] = '\0';
    return 0;
}

static int store(MYSQL_STMT *stmt);

// No parameters: the plain text protocol is enough.
int my_query0(const char *sql) {
    clear_result();
    if (!g_conn) { note_error(); return -1; }
    if (mysql_query(g_conn, sql) != 0) { note_error(); return -1; }
    MYSQL_RES *res = mysql_store_result(g_conn);
    if (!res) {
        if (mysql_field_count(g_conn) != 0) { note_error(); return -1; }
        g_error[0] = '\0';
        return 0;
    }
    g_cols = (int)mysql_num_fields(res);
    g_rows = (int)mysql_num_rows(res);
    if (g_rows > 0 && g_cols > 0) {
        g_cells = calloc((size_t)(g_rows * g_cols), sizeof(char *));
        MYSQL_ROW row;
        int r = 0;
        while ((row = mysql_fetch_row(res)) != NULL && r < g_rows) {
            unsigned long *lengths = mysql_fetch_lengths(res);
            for (int c = 0; c < g_cols; c++) {
                if (row[c]) {
                    size_t n = (size_t)lengths[c];
                    char *copy = malloc(n + 1);
                    memcpy(copy, row[c], n);
                    copy[n] = '\0';
                    g_cells[r * g_cols + c] = copy;
                } else {
                    g_cells[r * g_cols + c] = strdup("");
                }
            }
            r++;
        }
    }
    mysql_free_result(res);
    g_error[0] = '\0';
    return g_rows;
}

// One bound parameter, through a prepared statement so the value is never
// pasted into SQL. MySQL has no numbered placeholders, so the same value is
// bound to every `?` the statement carries — which is what plume needs, since
// its statements repeat one document parameter.
int my_query1(const char *sql, const char *a) {
    clear_result();
    if (!g_conn) { note_error(); return -1; }

    MYSQL_STMT *stmt = mysql_stmt_init(g_conn);
    if (!stmt) { note_error(); return -1; }
    if (mysql_stmt_prepare(stmt, sql, (unsigned long)strlen(sql)) != 0) {
        snprintf(g_error, sizeof(g_error), "%s", mysql_stmt_error(stmt));
        mysql_stmt_close(stmt);
        return -1;
    }

    unsigned long count = mysql_stmt_param_count(stmt);
    MYSQL_BIND *binds = NULL;
    unsigned long len = (unsigned long)strlen(a);
    if (count > 0) {
        binds = calloc(count, sizeof(MYSQL_BIND));
        for (unsigned long i = 0; i < count; i++) {
            binds[i].buffer_type = MYSQL_TYPE_STRING;
            binds[i].buffer = (void *)a;
            binds[i].buffer_length = len;
            binds[i].length = &len;
        }
        if (mysql_stmt_bind_param(stmt, binds) != 0) {
            snprintf(g_error, sizeof(g_error), "%s", mysql_stmt_error(stmt));
            free(binds);
            mysql_stmt_close(stmt);
            return -1;
        }
    }

    if (mysql_stmt_execute(stmt) != 0) {
        snprintf(g_error, sizeof(g_error), "%s", mysql_stmt_error(stmt));
        free(binds);
        mysql_stmt_close(stmt);
        return -1;
    }

    int rows = store(stmt);
    free(binds);
    mysql_stmt_close(stmt);
    if (rows < 0) return -1;
    g_error[0] = '\0';
    return rows;
}

// Pull a prepared statement's result set into g_cells as strings. Every column
// is fetched as text, because plume reads JSON documents and counts out of
// these and never needs a native type.
static int store(MYSQL_STMT *stmt) {
    MYSQL_RES *meta = mysql_stmt_result_metadata(stmt);
    if (!meta) {
        // A statement with no result set: an INSERT or an UPDATE.
        g_rows = 0;
        g_cols = 0;
        return 0;
    }
    g_cols = (int)mysql_num_fields(meta);
    mysql_free_result(meta);

    if (mysql_stmt_store_result(stmt) != 0) {
        snprintf(g_error, sizeof(g_error), "%s", mysql_stmt_error(stmt));
        g_cols = 0;
        return -1;
    }
    g_rows = (int)mysql_stmt_num_rows(stmt);
    if (g_rows == 0 || g_cols == 0) return g_rows;

    g_cells = calloc((size_t)(g_rows * g_cols), sizeof(char *));

    MYSQL_BIND *out = calloc((size_t)g_cols, sizeof(MYSQL_BIND));
    unsigned long *lengths = calloc((size_t)g_cols, sizeof(unsigned long));
    my_bool *is_null = calloc((size_t)g_cols, sizeof(my_bool));
    my_bool *error = calloc((size_t)g_cols, sizeof(my_bool));
    // A zero-length buffer makes the fetch report the true length in
    // `lengths` without copying, and the column is then re-fetched into a
    // buffer of exactly that size.
    for (int c = 0; c < g_cols; c++) {
        out[c].buffer_type = MYSQL_TYPE_STRING;
        out[c].buffer = NULL;
        out[c].buffer_length = 0;
        out[c].length = &lengths[c];
        out[c].is_null = &is_null[c];
        out[c].error = &error[c];
    }
    mysql_stmt_bind_result(stmt, out);

    int r = 0;
    while (r < g_rows) {
        int rc = mysql_stmt_fetch(stmt);
        if (rc == MYSQL_NO_DATA) break;
        if (rc != 0 && rc != MYSQL_DATA_TRUNCATED) break;
        for (int c = 0; c < g_cols; c++) {
            if (is_null[c]) {
                g_cells[r * g_cols + c] = strdup("");
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
            g_cells[r * g_cols + c] = buf;
        }
        r++;
    }
    g_rows = r;

    free(out);
    free(lengths);
    free(is_null);
    free(error);
    return g_rows;
}

int my_rows(void) { return g_rows; }

const char *my_value(int row, int col) {
    if (!g_cells || row < 0 || col < 0 || row >= g_rows || col >= g_cols) return "";
    const char *v = g_cells[row * g_cols + col];
    return v ? v : "";
}

const char *my_error(void) { return g_error; }

const char *my_version(void) {
    if (!g_conn) return "";
    return mysql_get_server_info(g_conn);
}

void my_close(void) {
    clear_result();
    if (g_conn) {
        mysql_close(g_conn);
        g_conn = NULL;
    }
    g_error[0] = '\0';
}

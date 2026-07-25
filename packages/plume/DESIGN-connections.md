# Connections and parameters

Two limits in the driver contract, and what replaces them.

## What is wrong now

**One connection per process.** Every shim holds its connection, and the last
result set, in file-scope statics:

```c
static PGconn  *g_conn = NULL;   /* plume_shim.c  */
static MYSQL   *g_conn = NULL;   /* mysql_shim.c  */
static sqlite3 *g_db   = NULL;   /* sqlite_shim.c */
```

Fine for a migration runner or a CLI. For a server it is a blocker twice over:
there is no pool, and because the *result set* is static too, two requests
interleaving would read each other's rows.

**One bound parameter per query.** The contract is `query(sql, a)` — a single
value — so `WHERE team_id = ? AND status = ?` cannot be expressed. The
workaround is to interpolate the second value, which is the route the MySQL
backslash injection came in by. A limit that pushes callers toward string
concatenation is a security defect, not an inconvenience.

## Handles

A connection becomes a handle: a small integer naming a slot in a fixed table
inside the shim. Each slot owns its own connection *and* its own result set, so
two handles cannot interfere.

```c
#define PL_MAX_CONNECTIONS 64

int  pl_acquire(void);                 /* a free slot, or -1 */
int  pl_open(int h, const char *conninfo);
void pl_release(int h);                /* closes and frees the slot */
int  pl_exec(int h, const char *sql);
int  pl_bind(int h, int i, const char *value);
int  pl_query(int h, const char *sql, int argc);
int  pl_rows(int h);
const char *pl_value(int h, int row, int col);
const char *pl_error(int h);
```

A fixed table rather than malloc'd handles: the count is a resource limit worth
having, an out-of-range handle is checked rather than dereferenced, and there is
nothing to leak.

Slot 0 is reserved for the process-wide connection, so `postgres()` keeps
meaning what it means today and every existing program is unaffected.

## The Lumen side

A `Db`'s functions capture the handle. Records are immutable and closures
capture by value, so the handle is decided when the `Db` is built — which is
right: a `Db` *is* a connection, not a thing that might later have one.

```ts
// Today's behaviour, unchanged: the process-wide connection, slot 0.
export function postgres(): Db

// Its own connection, for a pool.
export function postgresConnection(target: string): Db
```

A pool is then an array of `Db` and needs nothing from the driver:

```ts
let pool: Db[] = [];
let i: int = 0;
while (i < size) { pool.push(postgresConnection(target)); i = i + 1; }
```

Checking one out is the caller's business. plume does not schedule, because a
program with an event loop, a thread pool or one connection per request wants
three different answers and none of them belong in a mapper.

## Parameters

```ts
query: (sql: string, args: string[]) => bool,
```

The driver binds each argument in turn, then executes. On PostgreSQL that is
`PQexecParams` with `argc`; on SQLite and MySQL, the prepared statement's
parameters bound by index.

This removes the MySQL special case where one value was bound to every `?`,
which only worked because plume happened to build statements with a single
repeated parameter. With real binding, `?1`-style numbering is no longer needed
either — SQLite can go back to plain `?`.

`countWhere(db, repo, where, a)` and its neighbours grow an array where they
took a string. Every call inside plume passes one argument today, so the change
is mechanical; the callers that wanted two can now have them.

## What this does not do

- No scheduling, no checkout, no health checks, no reconnect-on-failure. An
  array of connections is a pool; deciding who gets one is the program's.
- No transaction affinity. A transaction is a connection, so a caller holding
  one holds a `Db`.
- No change to how a mapping, a migration or a relation is written.

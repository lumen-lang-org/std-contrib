# plume

An object mapper and migration tool for Lumen, against PostgreSQL, SQLite and
MySQL/MariaDB.

Nothing is inferred. A table name, a key, every column and every SQL type is
written out; plume never guesses a column from a field name or a table from a
type. The declaration that states the shape states the mapping with it:

```ts
import { entity } from "./entity.ts";
import { Db, DbConfig } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { DbRepository, connectDatabase, createTable, persist, findById } from "./plume.ts";

@entity("agents")
class Agent {
  @id @column("id", "text")
  id: string;

  @column("agent_name", "text")
  agentName: string;

  @column("max_steps", "int")
  maxSteps: int;

  @column("temperature", "float8")
  temperature: number;

  // No @column, so no column: a field the program keeps and the table does not.
  scratch: string;
}

// A row still crosses the boundary as a record, because a class instance cannot
// travel as JSON yet (spec 456).
type AgentRow = { id: string, agentName: string, maxSteps: int, temperature: number };

let database: Db = postgres();
let config: DbConfig = { host: "127.0.0.1", database: "app", user: "lumen" };
connectDatabase(database, config);

let agents: DbRepository = entityAgent;
createTable(database, agents);

let a: AgentRow = { id: "a1", agentName: "researcher", maxSteps: 5, temperature: 0.2 };
persist(database, agents, JSON.stringify(a));

let back: AgentRow = JSON.parse<AgentRow>(findById(database, agents, "a1"));
```

`agentName` becomes `agent_name` because the decorator was told to, not because
a convention inferred it. The compiler runs `entity` while compiling and leaves
its return value behind as a constant named for the decorator and the class —
`entityAgent`, a `DbRepository` record literal, so the program does no work at
startup to have it.

The decorator needs the decorator compiler (Lumen spec 455, merged). Everything
else in this package works on any Lumen build, and a mapping is an ordinary value
either way — a hand-built one is at the end, and every operation below takes
both.

A record crosses the boundary as JSON in both directions. That is what lets one
set of operations serve any record type without a generated mapper per type:
the database does the conversion, using functions it already has.

## Databases

| | PostgreSQL | SQLite | MySQL / MariaDB |
|---|---|---|---|
| module | `postgres.ts` | `sqlite.ts` | `mysql.ts` |
| links | `pq` | `sqlite3` | `mariadb` |
| config | `host`, `port`, `user`, `password`, `database` | `filename` | `host`, `port`, `user`, `password`, `database` |
| default port | 5432 | — | 3306 |
| verified against | PostgreSQL 17 | SQLite 3 | MySQL 8, MariaDB 11.8 |
| placeholder | `$1`, `$2`, … | `?` | `?` |

Each driver is its own module, so a program that uses SQLite does not need
libpq installed and vice versa. The core links nothing.

The same test suite runs against all three — `plume.test.ts`, `sqlite.test.ts`
and `mysql.test.ts` are the same suite with one import changed, which is what
makes "portable" a claim rather than an intention.

Where a caller writes SQL of their own — a `where` clause, a projection — it is
that database's SQL. Use `placeholderAt(database, 1)` rather than a literal
`$1` or `?` and the same call works everywhere; `database.placeholder` is the
first marker, for the common case of one value.

## Connecting

A connection is asked for with a record, not a string. A `host=… user=…` list
is untyped, spelled differently by every library, and a typo in it is a runtime
failure; the field names here are node-postgres's, verbatim.

```ts
let config: DbConfig = { host: "127.0.0.1", database: "app", user: "lumen", password: "secret" };
connectDatabase(database, config);

let local: DbConfig = { filename: "/tmp/app.db" };      // SQLite
let memory: DbConfig = { filename: ":memory:" };
```

Every field is optional; each driver applies its own defaults and renders the
config into whatever its library takes. Nothing outside a driver builds a target
string, and no diagnostic carries any part of the config — a failed connection
cannot put a password in a log. Values are quoted where the rendered form is a
`key=value` list, so a password containing a space connects where it says rather
than being cut short at the space. A config naming neither a `host` nor a
`filename` is reported rather than attempted, since libpq and SQLite would both
happily connect to something else.

`options` is the escape hatch: anything the fields do not cover — `sslmode`, a
socket path, a libpq service name — appended verbatim, and a config carrying
only `options` is a raw target.

### A connection of its own

`postgres()`, `sqlite()` and `mysql()` are the process-wide connection, which is
what a CLI or a migration runner wants. `postgresConnection(config)`,
`sqliteConnection(config)` and `mysqlConnection(config)` each open a connection
of their own, out of a table of 64 slots per driver, and each owns its own
result set — so two of them interleaved cannot read each other's rows.

```ts
let pool: Db[] = [];
let i: int = 0;
while (i < size) { pool.push(postgresConnection(config)); i = i + 1; }
```

That is a pool. Handing one out is the program's business: a program with an
event loop, a thread pool or one connection per request wants three different
answers and none of them belong in a mapper. `close()` releases the slot.

## Building

The drivers link C shims, built by this package's `build.sh`. Each shim is
optional; a missing library is a skipped shim rather than a failed build.

<!-- website:skip -->
```sh
sh packages/plume/build.sh
```
<!-- /website:skip -->

```sh
apt install libpq-dev libsqlite3-dev libmariadb-dev   # Debian, Ubuntu
brew install postgresql@17 sqlite mariadb             # macOS
```

## Operations

Reading: `findById`, `findProjected`, `listWhere`, `listProjected`, `pageWhere`,
`countWhere`, `existsById`.

Writing: `persist`, `persistMany`, `deleteById`, `deleteWhere`.

Schema: `createTable`, `dropTable`. Transactions: `beginTransaction`,
`commitTransaction`, `rollbackTransaction`. Escape hatch: `execute`.

A projection is a select list you write, so a DTO is a query rather than a
generated mapper — `agent_name AS "agentName"` is what a Java mapper spells with
an annotation:

```ts
let summary = findProjected(database, agents(), "id, agent_name AS \"agentName\"", "a1");
```

`listWhere`, `listProjected`, `countWhere` and `deleteWhere` take an array of
values, one per marker in the clause, and the driver binds each in its own place
— as does `args` on the query record the ordered reads take:

```ts
let where = "agent_name = " + placeholderAt(database, 1)
  + " AND max_steps > " + placeholderAt(database, 2);
listWhere(database, agents(), where, ["critic", "4"]);
```

`pickFields` does the same narrowing in memory, without a round trip.

### Ordering

```ts
listOrdered(database, agents, { order: [
  { column: "max_steps", direction: "desc" },
  { column: "agent_name" },                    // omitted is "asc", as in SQL
] });

pageOrdered(database, agents, { order: [{ column: "id" }], limit: 20, offset: 40 });

listOrdered(database, agents, { where: "enabled = " + database.placeholder,
                                args: ["1"], order: [{ column: "agent_name" }] });
```

What to read past the mapping is one `DbQuery` record — `where`, `args`, `order`
or `orderBy`, `limit`, `offset`, every field optional, so `{}` is every row. It
was a positional tail ending in two bare numbers, and a caller who passed the
offset where the limit goes got a page the database was happy to return.

`direction` is `"asc" | "desc"` rather than a `descending` boolean, because a
boolean only reads correctly beside the name of the function that set it:
`{ column: "agent_name", descending: false }` says "not descending" where SQL,
and every caller, says ascending.

There were `asc(column)` and `desc(column)` constructors for this, and there are
not now: a constructor whose whole body is a record literal is a second spelling
of the same value, a name to import, and one more thing to look up to find out
which field it sets.

A key that is not a plain identifier refuses the whole query rather than being escaped into it, and
`pageOrdered` refuses a page with no ordering at all — two requests for "the
first twenty" can overlap or skip rows when the database is free to answer in
any order, so an unordered page is not a page.

The array is assembled from one document per row rather than aggregated in SQL,
because MySQL's `JSON_ARRAYAGG` does not preserve the order of what it
aggregates: a subquery's `ORDER BY` decides which rows come back and not the
order they sit in. `pageWhere` was silently unordered on MySQL until this, and
its test passed only because `LIMIT 1` makes order unobservable.

An alias must be a plain name, on every driver. PostgreSQL would accept any
quoted identifier, but a driver that builds the document's keys itself cannot,
and a projection that works in development and is refused in production has not
made anything portable. Expressions are otherwise free: `coalesce(a, b) AS "x"`
is read correctly, commas and all.

## A repository

`store.ts` binds a mapping to a connection, which is what Panache calls a
repository and what you inject:

```ts
let agents = store(database, agentsMapping());

agents.findById("a1");
agents.list();
agents.listOrdered({ where: "max_steps <= " + agents.db.placeholder, args: ["4"],
                     order: [{ column: "agent_name" }] });
agents.persist(JSON.stringify(a));
agents.count();
```

plume's operations take `(db, mapping, ...)` because that keeps them ordinary
functions — testable, composable, nothing hidden. But threading the same two
values through every call is doing bookkeeping by hand, and a class holding
both is holding one thing twice.

A `Store` adds no capability: every method is the same function with the first
two arguments supplied. It carries `db` and `mapping`, so anything it does not
cover is one plume call away.

It is named `Store` rather than `Repository` because `DbRepository` is already
the mapping here. That is arguably the wrong name for a mapping — Panache would
call the bound thing the repository — and renaming the older type is a change
worth making deliberately rather than in passing.

## Relations

A related row, or rows, fetched with the record that points at them:

```ts
let rs: DbRelation[] = [
  hasOne({ field: "team", table: "teams", localColumn: "team_id", foreignColumn: "id",
           columns: "id, team_name AS \"teamName\"" }),
  hasMany({ field: "tasks", table: "tasks", localColumn: "id", foreignColumn: "agent_id",
            columns: "id, title" }),
];
let agents = repository({ table: "agents", idField: "id", idColumn: "id",
                          fields: fields, relations: rs });

findById(database, agents, "a1");
```

```json
{"id":"a1","agentName":"researcher","teamId":"t1",
 "team":{"id":"t1","teamName":"research"},
 "tasks":[{"id":"k1","title":"read"},{"id":"k2","title":"write"}]}
```

**This is not a join.** Each relation is a correlated subquery producing its own
JSON, which all three databases nest inside the parent document. A join would
flatten the two into one row set and leave you to regroup — and a to-many would
repeat the parent once per child. Here a parent with two tasks is still one row:
`countWhere` returns what it returned before the relation existed.

A to-one that matches nothing is `null`; a to-many that matches nothing is `[]`.
The last argument is a select list over the other table, read the same way a
projection is, so `team_name AS "teamName"` names the key. A relation whose
names or select list will not parse refuses the read rather than sending it.

With the decorator, the relation is declared on the field that holds it:

```ts
@entity("agents")
class Agent {
  @id @column("id", "text")           id: string;
  @column("team_id", "text")          teamId: string;

  @hasOne("teams", "team_id", "id", "id, team_name AS \"teamName\"")
  team: Team;

  @hasMany("tasks", "id", "agent_id", "id, title")
  tasks: Task[];
}
```

The decorator's arguments stay positional where `hasOne` and `hasMany` take a
record, because the compiler hands a decorator its arguments as a list of
strings — `DecoratorUse.args` — and a record literal is not one. Same four
values, same order as the record's fields, and `entity` is what turns one into
the other.

### Foreign keys

A relation already says which column points at which column of which table,
which is a foreign key written out. plume will generate the constraint but
never adds it for you: a schema change belongs in a migration, where it is
recorded and checksummed like every other one.

```ts
let plan: Migration[] = [
  migration("1", "teams",  createTableSql(database, teams)),
  migration("2", "agents", createTableSqlWithKeys(database, agents)),
];
```

`createTable` is unchanged — a relation adds nothing to it, so no existing
schema moves. `createTableSql` is the statement it runs, and
`createTableSqlWithKeys` is that statement with a `REFERENCES` clause per
to-one relation. A to-many adds nothing here: its column lives on the other
table, so the constraint belongs to that table's mapping.

On PostgreSQL and MySQL, `foreignKeys(db, repo)` returns `ALTER TABLE ... ADD
CONSTRAINT` statements instead, which do not constrain creation order:

```ts
migration("3", "agent keys", foreignKeys(database, agents)[0]),
// ALTER TABLE agents ADD CONSTRAINT fk_agents_team_id
//   FOREIGN KEY (team_id) REFERENCES teams (id)
```

SQLite cannot add a constraint to a table that exists, so `foreignKeys` is
empty there and `createTableSqlWithKeys` is the route — and SQLite enforces
foreign keys only after `PRAGMA foreign_keys = ON`, which is its choice and
one the tests state rather than leave to be discovered.

### Many-to-many

Through a link table, including the case where both sides are the same table:

```ts
let rs: DbRelation[] = [
  hasManyThrough({
    field: "servers", table: "mcp_servers", foreignColumn: "id",
    linkTable: "agent_mcp_servers", linkLocalColumn: "agent_id", linkForeignColumn: "server_id",
    localColumn: "id", columns: "id, server_name AS \"serverName\", url",
  }),
  hasManyThrough({
    field: "subAgents", table: "agents", foreignColumn: "id",
    linkTable: "agent_children", linkLocalColumn: "parent_id", linkForeignColumn: "child_id",
    localColumn: "id", columns: "id, agent_name AS \"agentName\"",
  }),
];
```

```json
{"id":"a1","agentName":"lead",
 "servers":[{"id":"s1","serverName":"filesystem","url":"stdio://fs"}],
 "subAgents":[{"id":"a2","agentName":"scout"}]}
```

Reads as: this row's `id` matches `agent_mcp_servers.agent_id`, and
`agent_mcp_servers.server_id` matches `mcp_servers.id`.

The far table is aliased in the generated subquery, which is what makes the
second relation work. Without it `agents.id = agents.parent_id` binds both
sides to the inner table and asks for rows that are their own parent — which
answers `[]` rather than failing, so it is the kind of bug a test finds and an
eye does not.

A to-one through a link table is refused: a link yields many, and promising
otherwise is a promise the database will not keep.

What is still missing: `FROM a JOIN b` proper, so no fetching two whole entities
in one query.

## Migrations

`migrate.ts` is Flyway's model: an ordered plan of versioned steps, a history
table, and a CRC-32 checksum over each step so an applied migration that has
since been edited is refused rather than silently skipped.

```ts
import { Migration, migration, repeatable, migrate, migrationInfo } from "./migrate.ts";

let plan: Migration[] = [
  migration("1", "create agents", "CREATE TABLE agents (id text PRIMARY KEY)"),
  migration("1.1", "add name", "ALTER TABLE agents ADD COLUMN agent_name text"),
  repeatable("active view", "CREATE OR REPLACE VIEW active AS SELECT * FROM agents"),
];

let r = migrate(database, plan);
if (!r.ok) { console.error(r.failedVersion, r.error); }
```

What it does:

- **Ordering** by version, numerically, so `1.10` runs after `1.9`. The plan
  does not have to be written in order.
- **Checksums.** Editing an applied migration is an error naming both
  checksums. `repairChecksums` accepts the edit when it was deliberate.
- **Out-of-order detection.** A version below one already applied — two
  branches merging — is refused unless you call
  `migrateAllowingOutOfOrder`.
- **Missing migrations.** A step deleted from the plan after it ran is
  reported, because the next database built from that plan would differ.
- **Repeatable steps.** No version; re-run whenever their SQL changes. For
  views and procedures, which are easier to redefine than to alter.
- **Baseline** for adopting plume on a database that already has a schema.
- **`migrationInfo`** reports what would happen without doing it.

### A plan from a directory

The statements can live in `.sql` files, named the way Flyway names them, with
the version and description read from the name:

```
sql/1__create_teams.sql         version 1,   "create teams"
sql/1_1__add_team_name.sql      version 1.1, "add team name"
sql/2__create_agents.sql        version 2,   "create agents"
sql/R__active_agents_view.sql   repeatable,  "active agents view"
```

A name starts with its version. Flyway's `V` prefix is accepted, since
directories full of it exist, but nothing needs it.

```ts
let plan = migrationsFrom(embedDir("./sql"));
migrate(database, plan);
```

Adding a migration is adding a file. A single underscore is a dot in the
version and a space in the description; `__` separates the two, which is why a
description cannot contain one.

`embedDir` reads the directory **while compiling** (Lumen spec 458), so the SQL
is reviewable as SQL and the program is still one binary — delete `sql/` after
building and it still runs. Nothing requires `embedDir`, though:
`migrationsFrom` takes any list of names and contents.

A file that is not a migration — a `README.md` beside the SQL — is left out of
the plan and reported by `migrationNameViolation`. It is not silently skipped: a
migration named wrongly would otherwise never run and never be missed.

Everything after the name is still checked. Ordering is by version, so `10`
runs after `9` where a name sort would get it backwards; the checksum is over
the file's contents, so editing an applied `.sql` is refused exactly as editing
an inline string was.

### The state table

`plume_schema_history`, created on first use, is what every one of those checks
reads:

```
rank | version | description   | checksum    | applied
  1  | 1       | create teams  |  2061472074 | 2026-07-25 08:53:03
  2  | 1.1     | add team name |    87105387 | 2026-07-25 08:53:03
  3  | 2       | create agents | -1224966372 | 2026-07-25 08:53:03
  4  | (rpt)   | active agents |  1515252556 | 2026-07-25 08:53:03
```

The files were handed over as `2`, `1`, `R`, `1.1` — the ranks show the order
they actually ran in. `installed_rank` records that order, `checksum` is the
CRC-32 of the file's contents, and `installed_on`, `execution_ms` and `success`
round out the row. The table name is fixed rather than configurable, because
two of them in one database is a way to apply everything twice.

Migration bodies are your SQL, not plume's, so they are spelled for the
database they run against.

## A mapping built by hand

A mapping is an ordinary value, so nothing requires a decorator to produce it.
`repository` takes the table, the key's field and column, and the fields:

```ts
import { field, repository, DbField, DbRepository } from "./plume.ts";

type AgentRow = { id: string, agentName: string, maxSteps: int, temperature: number };

function agents(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("temperature", "temperature", "float8"),
  ];
  return repository({ table: "agents", idField: "id", idColumn: "id", fields: fields });
}

persist(database, agents(), JSON.stringify(a));
```

Every operation in this README takes the result either way — `entityAgent` and
`agents()` are the same record. Use this form on a Lumen build without the
decorator compiler, or where the mapping is computed rather than declared:
`agentsFull` in the `agents` package builds its relations from a list, which a
class cannot state.

The cost is that the shape is written twice, and the two can disagree without
anything saying so. That is what `@entity` removes.

### Why the decorator is a function

A decorator in Lumen is a pure function from a description of the declaration to
a value — here, a `DbRepository`. That is why `entity` is an ordinary function of
an ordinary type, tested by calling it: `entity.test.ts` needs no compiler
support to run, and `entity_live.test.ts` checks that the generated mapping is
identical to the hand-written one and that every operation works against it.

Still nothing is inferred: a field without `@column` is not mapped, a class
without `@id` has no key and `entityViolation` says so. The one exception is a
`@column("id")` with no type, which falls back to the declared type — the
column type can always be stated outright.

<!-- website:skip -->
## Testing

```sh
sh packages/plume/build.sh
createdb lumenvec                       # PostgreSQL
docker run -d --name plume-mysql -e MYSQL_ROOT_PASSWORD=lumen \
  -e MYSQL_DATABASE=lumentest -p 13306:3306 mysql:8
docker run -d --name plume-mariadb -e MARIADB_ROOT_PASSWORD=lumen \
  -e MARIADB_DATABASE=lumentest -p 13307:3306 mariadb:11

cd packages/plume
lumen test plume.test.ts                # PostgreSQL operations
lumen test sqlite.test.ts               # the same, on SQLite
lumen test mysql.test.ts                # the same, on MySQL
lumen test migrate.test.ts              # migrations, SQLite
lumen test migrate_pg.test.ts           # migrations, PostgreSQL
lumen test migrate_mysql.test.ts        # migrations, MySQL
lumen test entity.test.ts               # the @entity decorator, offline
lumen test entity_live.test.ts          # its mapping against a database
lumen test relations.test.ts            # relations, SQLite
lumen test relations_pg.test.ts         # relations, PostgreSQL
lumen test relations_mysql.test.ts      # relations, MySQL
lumen test foreignkeys.test.ts          # generated keys, SQLite
lumen test foreignkeys_pg.test.ts       # generated keys, PostgreSQL
lumen test foreignkeys_mysql.test.ts    # generated keys, MySQL
lumen test migratenames.test.ts         # the V1__name.sql convention
lumen test ordering.test.ts             # ordering, SQLite
lumen test ordering_pg.test.ts          # ordering, PostgreSQL
lumen test ordering_mysql.test.ts       # ordering, MySQL
lumen test store.test.ts                # the bound repository
lumen test linkrelations.test.ts        # many-to-many, SQLite
lumen test linkrelations_pg.test.ts     # many-to-many, PostgreSQL
lumen test linkrelations_mysql.test.ts  # many-to-many, MySQL
```

`PLUME_TEST_CONNINFO` and `PLUME_MYSQL_CONNINFO` override the connections; a
suite passes whatever they hold through `options`, so setting one exercises the
raw-target hatch as well. The
MySQL suites pass unmodified against MariaDB — point `PLUME_MYSQL_CONNINFO` at
port 13307 above to see it, which is the only evidence that "and MariaDB" is a
fact rather than an assumption about wire compatibility.

A suite can be run from anywhere — the shims are linked relative to the driver
that names them, not to the working directory.

Every suite runs against a real server. None of these claims survive a mock:
the database is half of the mapper.
<!-- /website:skip -->

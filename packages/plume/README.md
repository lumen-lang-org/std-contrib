# plume

An object mapper and migration tool for Lumen, against PostgreSQL, SQLite and
MySQL/MariaDB.

Nothing is inferred. A table name, a key, every column and every SQL type is
written out; plume never guesses a column from a field name or a table from a
type. The mapping is a value you construct, so it can be built, inspected and
tested like any other value.

```ts
import { Db, DbConfig } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { field, repository, connectDatabase, createTable, persist, findById } from "./plume.ts";

type Agent = { id: string, agentName: string, maxSteps: int, temperature: number };

let database: Db = postgres();

function agents(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("temperature", "temperature", "float8"),
  ];
  return repository("agents", "id", "id", fields);
}

let config: DbConfig = { host: "127.0.0.1", database: "app", user: "lumen" };
connectDatabase(database, config);
createTable(database, agents());

let a: Agent = { id: "a1", agentName: "researcher", maxSteps: 5, temperature: 0.2 };
persist(database, agents(), JSON.stringify(a));

let back: Agent = JSON.parse<Agent>(findById(database, agents(), "a1"));
```

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

```sh
sh packages/plume/build.sh
```

Each shim is optional; a missing library is a skipped shim rather than a failed
build.

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

`listWhere`, `listProjected`, `pageWhere`, `countWhere` and `deleteWhere` take
an array of values, one per marker in the clause, and the driver binds each in
its own place:

```ts
let where = "agent_name = " + placeholderAt(database, 1)
  + " AND max_steps > " + placeholderAt(database, 2);
listWhere(database, agents(), where, ["critic", "4"]);
```

`pickFields` does the same narrowing in memory, without a round trip.

An alias must be a plain name, on every driver. PostgreSQL would accept any
quoted identifier, but a driver that builds the document's keys itself cannot,
and a projection that works in development and is refused in production has not
made anything portable. Expressions are otherwise free: `coalesce(a, b) AS "x"`
is read correctly, commas and all.

## Relations

A related row, or rows, fetched with the record that points at them:

```ts
let rs: DbRelation[] = [
  hasOne("team", "teams", "team_id", "id", "id, team_name AS \"teamName\""),
  hasMany("tasks", "tasks", "id", "agent_id", "id, title"),
];
let agents = repositoryWith("agents", "id", "id", fields, rs);

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

What is still missing: `FROM a JOIN b` proper, so no fetching two whole entities
in one query, and no relation that spans a link table.

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
the plan and reported by `migrationNameProblem`. It is not silently skipped: a
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

## The `@entity` decorator

`entity.ts` derives a mapping from a decorated class, so the fields are stated
once instead of twice:

```ts
@entity("agents")
class Agent {
  @id @column("id", "text")
  id: string;

  @column("agent_name", "text")
  agentName: string;
}

persist(database, entityAgent, JSON.stringify(a));
```

A decorator in Lumen is a pure function from a description of the declaration
to a value — here, a `DbRepository`. That is why `entity` is an ordinary
function of an ordinary type, tested by calling it, and why `entity.test.ts`
exists before the compiler can run a decorator at all (spec 455 is not landed).

Still nothing is inferred: a field without `@column` is not mapped, a class
without `@id` has no key and `entityProblem` says so. The one exception is a
`@column("id")` with no type, which falls back to the declared type — the
column type can always be stated outright.

`entity_live.test.ts` checks that the generated mapping is identical to the
hand-written one and that every operation works against it.

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

# plume

An object mapper and migration tool for Lumen, against PostgreSQL, SQLite and
MySQL/MariaDB.

Nothing is inferred. A table name, a key, every column and every SQL type is
written out; plume never guesses a column from a field name or a table from a
type. The mapping is a value you construct, so it can be built, inspected and
tested like any other value.

```ts
import { Db } from "./driver.ts";
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

connectDatabase(database, "host=127.0.0.1 user=lumen dbname=app");
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
| target | libpq conninfo | a file path or `:memory:` | `host=… user=… dbname=…` |
| placeholder | `$1` | `?1` | `?` |

Each driver is its own module, so a program that uses SQLite does not need
libpq installed and vice versa. The core links nothing.

The same test suite runs against all three — `plume.test.ts`, `sqlite.test.ts`
and `mysql.test.ts` are the same 30 assertions with one import changed, which
is what makes "portable" a claim rather than an intention.

Where a caller writes SQL of their own — a `where` clause, a projection — it is
that database's SQL. Use `database.placeholder` rather than a literal `$1` and
the same call works everywhere.

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

`pickFields` does the same narrowing in memory, without a round trip.

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

There is no filename convention. A plan is a value, written in the program or
assembled from anywhere, so nothing depends on how a file happens to be named.

Migration bodies are your SQL, not plume's, so they are spelled for the
database they run against.

## Testing

```sh
sh packages/plume/build.sh
createdb lumenvec                       # PostgreSQL
docker run -d --name plume-mysql -e MYSQL_ROOT_PASSWORD=lumen \
  -e MYSQL_DATABASE=lumentest -p 13306:3306 mysql:8

cd packages/plume
lumen test plume.test.ts                # PostgreSQL operations
lumen test sqlite.test.ts               # the same, on SQLite
lumen test mysql.test.ts                # the same, on MySQL
lumen test migrate.test.ts              # migrations, SQLite
lumen test migrate_pg.test.ts           # migrations, PostgreSQL
lumen test migrate_mysql.test.ts        # migrations, MySQL
```

`PLUME_TEST_CONNINFO` and `PLUME_MYSQL_CONNINFO` override the connections.

Every suite runs against a real server. None of these claims survive a mock:
the database is half of the mapper.

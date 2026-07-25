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
| verified against | PostgreSQL 17 | SQLite 3 | MySQL 8, MariaDB 11.8 |
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

There is no filename convention. A plan is a value, written in the program or
assembled from anywhere, so nothing depends on how a file happens to be named.

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
```

`PLUME_TEST_CONNINFO` and `PLUME_MYSQL_CONNINFO` override the connections. The
MySQL suites pass unmodified against MariaDB — point `PLUME_MYSQL_CONNINFO` at
port 13307 above to see it, which is the only evidence that "and MariaDB" is a
fact rather than an assumption about wire compatibility.

A suite can be run from anywhere — the shims are linked relative to the driver
that names them, not to the working directory.

Every suite runs against a real server. None of these claims survive a mock:
the database is half of the mapper.

# pgvector

A persistent vector store: PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector)
extension, reached through the C FFI.

## Why

The `ai` package's built-in store is a slice held in memory. It is rebuilt on
every start, so a service re-embeds its whole corpus each time it boots and pays
a provider for text that has not changed. It also scans every vector on every
query.

This keeps the vectors in a table. An index survives a restart, grows a document
at a time, and is searched by the database with a real index rather than by a
loop in your program.

## Install

```sh
apt install postgresql-17 postgresql-17-pgvector libpq-dev   # Debian, Ubuntu
brew install postgresql@17 pgvector                          # macOS

createdb lumenvec
psql lumenvec -c 'CREATE EXTENSION vector'

sh packages/pgvector/build.sh
```

`build.sh` finds libpq's headers through `pg_config` and produces
`pgvector_shim.o`. Because `// @link` paths resolve against the working
directory, compile programs that import this from `packages/pgvector`.

## Use

```ts
import { pgConnect, pgCreateStore, pgUpsert, pgSearch, pgClose } from "./pgvector.ts";

pgConnect("host=127.0.0.1 user=lumen password=lumen dbname=lumenvec");

// The width must match the embedding model: mistral-embed is 1024,
// text-embedding-3-small is 1536.
pgCreateStore("docs", 1024);

pgUpsert("docs", "notes.txt#0", chunkText, "notes.txt", "chunk=0", vector);

let hits = pgSearch("docs", queryVector, 5);
for (const h of hits) {
  console.log(`${h.score}  ${h.source}  ${h.text}`);
}

pgClose();
```

## API

| function | does |
| --- | --- |
| `pgConnect(conninfo)` | open a connection from a libpq conninfo string |
| `pgConnected()` / `pgServerVersion()` / `pgClose()` | connection state |
| `pgCreateStore(table, dims)` | create the extension and table if absent |
| `pgCreateIndex(table, lists)` | build an ivfflat cosine index |
| `pgDropStore(table)` | drop the table |
| `pgUpsert(table, id, text, source, metadata, embedding)` | insert or replace |
| `pgDeleteById(table, id)` / `pgDeleteBySource(table, source)` | remove |
| `pgCount(table)` / `pgHas(table, id)` / `pgGet(table, id)` | inspect |
| `pgSearch(table, query, k)` | the k nearest chunks |
| `pgSearchInSource(table, query, source, k)` | the same, within one document |
| `pgSearchWithin(table, query, k, maxDistance)` | nearest, no further than a bound |
| `pgVectorLiteral(v)` / `pgParseVector(s)` | pgvector's text form |
| `pgSafeIdentifier(name)` | whether a name is usable as a table |

A `PgHit` carries `id`, `text`, `source`, `metadata`, `distance` and `score`.
`distance` is what the database returned, so smaller is nearer; `score` is
`1 - distance`, the cosine similarity that reads the familiar way.

Calls that change something return a `PgResult` — `{ ok, rows, error }` — with
the database's own message rather than one this package invented.

### Why the names are prefixed

The prefix names the store rather than dodging a clash. `pgVectorLiteral` and
`pgParseVector` are pgvector's own wire format, and `pgSearch` says which
store is being searched when a program has more than one.

It began as a workaround — two modules exporting `search` used to be a
compile error — and that reason is gone: the compiler now renames internally
and importers resolve through the exporting module's table (spec 476). The
names stay because they read well, not because they must.

## Skipping work you have already paid for

The point of persisting vectors is not to embed the same text twice:

```ts
let pending: string[] = [];
for (const part of parts) {
  if (!pgHas("docs", part.id)) { pending = [...pending, part.text]; }
}
if (pending.length > 0) {
  let vectors = embedBatchWithConfig(cfg, pending);
  // ... upsert them
}
```

`examples/index-and-search.ts` is a runnable version. Run it twice: the second
run reports `all 3 chunks already stored — no embedding calls`.

## Choosing a search

`pgSearch` always returns `k` rows, however unrelated they are — cosine
similarity has no notion of "no match". When "nothing matched" must be a
possible answer, use `pgSearchWithin` with a distance ceiling.

Build an index once a table holds enough rows that a scan is slow. Below a few
thousand, a sequential scan is faster than an ivfflat index and exact besides;
an approximate index trades recall for speed, which is a bad trade on a small
table.

## Safety

Every value is sent as a bound parameter through `PQexecParams`, never pasted
into statement text, so a document containing a quote is data rather than
syntax. A test stores the string `it's a test'); DROP TABLE lumen_test_vectors; --`
and then checks the table is still there.

Table names cannot be bound — SQL has no placeholder for an identifier — so
they are checked against `pgSafeIdentifier` (letters, digits, underscores, not
starting with a digit) and refused otherwise.

## Tests

```sh
cd packages/pgvector && lumen test pgvector.test.ts
```

They need a live database, which is the point: the distance operators, the
vector literal round-trip, and the width check are the parts worth knowing are
real, and none of them can be tested against a mock. Override the connection
with `PGVECTOR_TEST_CONNINFO`.

## Limits

- One connection and one live result at a time, held behind globals in the
  shim, as the FFI has no handle type to pass back and forth.
- No transactions, no prepared statements, no connection pooling.
- No `COPY` bulk load: rows go in one at a time, which is fine for thousands
  and slow for millions.
- Only cosine distance is exposed. pgvector also has L2 and inner product; they
  would be a flag on the search functions.
- Vectors are sent as text rather than binary, so a large batch spends time in
  formatting that a binary path would not.
- Both shims must sit in the compile working directory when one program links
  two FFI packages, because `// @link` paths resolve against it rather than
  against the source file. `examples/rag-pdf.ts` links this and `pdf`, and says
  so in its header.

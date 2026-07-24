// A live database is required: these exercise real SQL against real pgvector,
// which is the only way to know the distance operators and the vector literal
// round-trip actually agree with what this package builds.
//
//   sh packages/pgvector/build.sh
//   createdb lumenvec && psql lumenvec -c 'CREATE EXTENSION vector'
//   cd packages/pgvector && lumen test pgvector.test.ts
//
// Override the connection with PGVECTOR_TEST_CONNINFO.

import { pgConnect, pgConnected, pgClose, pgServerVersion, pgCreateStore, pgDropStore, pgCreateIndex, pgUpsert, pgDeleteById, pgDeleteBySource, pgCount, pgHas, pgGet, pgSearch, pgSearchInSource, pgSearchWithin, pgVectorLiteral, pgParseVector, pgSafeIdentifier } from "./pgvector.ts";

const TABLE = "lumen_test_vectors";

function testConninfo(): string {
  let fromEnv = process.env("PGVECTOR_TEST_CONNINFO") ?? "";
  if (fromEnv != "") { return fromEnv; }
  return "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec";
}

// Three vectors in three dimensions, far enough apart that ordering is not a
// matter of floating-point luck.
function vecA(): number[] { let v: number[] = [1.0, 0.0, 0.0]; return v; }
function vecB(): number[] { let v: number[] = [0.0, 1.0, 0.0]; return v; }
function vecC(): number[] { let v: number[] = [0.9, 0.1, 0.0]; return v; }

function fresh(): void {
  pgConnect(testConninfo());
  pgDropStore(TABLE);
  pgCreateStore(TABLE, 3);
}

function seed(): void {
  fresh();
  pgUpsert(TABLE, "a", "alpha document", "one.txt", "lang=en", vecA());
  pgUpsert(TABLE, "b", "beta document", "two.txt", "lang=en", vecB());
  pgUpsert(TABLE, "c", "gamma document", "one.txt", "lang=fr", vecC());
}

// --- offline helpers ---------------------------------------------------------

test("a vector round-trips through pgvector's text form", () => {
  let v: number[] = [0.5, -1.25, 3.0];
  let back = pgParseVector(pgVectorLiteral(v));
  expect(back.length == 3);
  expect(back[0] == 0.5);
  expect(back[1] == -1.25);
  expect(back[2] == 3.0);
});

test("an empty vector's literal parses back to nothing", () => {
  expect(pgParseVector("[]").length == 0);
  expect(pgParseVector("").length == 0);
});

test("a table name must be an identifier", () => {
  // The table name cannot be a bound parameter, so it is checked instead.
  expect(pgSafeIdentifier("docs"));
  expect(pgSafeIdentifier("lumen_test_vectors"));
  expect(!pgSafeIdentifier("docs; DROP TABLE users"));
  expect(!pgSafeIdentifier("docs--"));
  expect(!pgSafeIdentifier("1docs"));
  expect(!pgSafeIdentifier(""));
  expect(!pgSafeIdentifier("a b"));
});

// --- connection ----------------------------------------------------------------

test("a connection opens and reports the server version", () => {
  let r = pgConnect(testConninfo());
  expect(r.ok);
  expect(pgConnected());
  expect(pgServerVersion() > 0);
});

test("a bad connection is reported, not raised", () => {
  let r = pgConnect("host=127.0.0.1 port=1 dbname=nope user=nobody");
  expect(!r.ok);
  expect(r.error.length > 0);
  // The process is still alive to run this, which is the point.
  expect(pgConnect(testConninfo()).ok);
});

// --- schema --------------------------------------------------------------------

test("a store is created and dropped", () => {
  pgConnect(testConninfo());
  expect(pgCreateStore(TABLE, 3).ok);
  expect(pgCount(TABLE) == 0);
  expect(pgDropStore(TABLE).ok);
  // A dropped table has no count.
  expect(pgCount(TABLE) == -1 || pgCount(TABLE) == 0);
});

test("creating a store twice is not an error", () => {
  fresh();
  expect(pgCreateStore(TABLE, 3).ok);
});

test("an unsafe table name is refused before it reaches SQL", () => {
  pgConnect(testConninfo());
  let r = pgCreateStore("docs; DROP TABLE lumen_test_vectors", 3);
  expect(!r.ok);
  expect(r.error.indexOf("unsafe table name") >= 0);
});

// --- writing --------------------------------------------------------------------

test("chunks are stored and counted", () => {
  seed();
  expect(pgCount(TABLE) == 3);
  expect(pgHas(TABLE, "a"));
  expect(!pgHas(TABLE, "nope"));
});

test("re-inserting an id replaces it rather than duplicating", () => {
  seed();
  expect(pgUpsert(TABLE, "a", "alpha rewritten", "one.txt", "lang=en", vecA()).ok);
  expect(pgCount(TABLE) == 3);
  expect(pgGet(TABLE, "a").text == "alpha rewritten");
});

test("an empty embedding is refused", () => {
  seed();
  let none: number[] = [];
  let r = pgUpsert(TABLE, "z", "text", "s", "", none);
  expect(!r.ok);
  expect(r.error.indexOf("empty embedding") >= 0);
  expect(pgCount(TABLE) == 3);
});

test("a vector of the wrong width is reported by the database", () => {
  seed();
  let wide: number[] = [1.0, 2.0, 3.0, 4.0];
  let r = pgUpsert(TABLE, "z", "text", "s", "", wide);
  expect(!r.ok);
  expect(r.error.length > 0);
});

test("text containing a quote is stored as data, not syntax", () => {
  seed();
  let nasty = "it's a test'); DROP TABLE lumen_test_vectors; --";
  expect(pgUpsert(TABLE, "q", nasty, "one.txt", "", vecA()).ok);
  expect(pgGet(TABLE, "q").text == nasty);
  // The table survived, which it would not have if the text had been pasted in.
  expect(pgCount(TABLE) == 4);
});

test("a chunk is deleted by id", () => {
  seed();
  expect(pgDeleteById(TABLE, "a").ok);
  expect(pgCount(TABLE) == 2);
  expect(!pgHas(TABLE, "a"));
});

test("every chunk of a source is deleted at once", () => {
  seed();
  // a and c both come from one.txt.
  expect(pgDeleteBySource(TABLE, "one.txt").ok);
  expect(pgCount(TABLE) == 1);
  expect(pgHas(TABLE, "b"));
});

test("a missing chunk reads as an empty hit", () => {
  seed();
  expect(pgGet(TABLE, "absent").id == "");
});

// --- searching -------------------------------------------------------------------

test("the nearest vector comes first", () => {
  seed();
  // vecA is identical to a's vector and close to c's.
  let hits = pgSearch(TABLE, vecA(), 3);
  expect(hits.length == 3);
  expect(hits[0].id == "a");
  expect(hits[1].id == "c");
  expect(hits[2].id == "b");
});

test("an exact match scores one and sits at distance zero", () => {
  seed();
  let hits = pgSearch(TABLE, vecA(), 1);
  expect(hits[0].distance < 0.000001);
  expect(hits[0].score > 0.999999);
});

test("distances rise across the result, and scores fall", () => {
  seed();
  let hits = pgSearch(TABLE, vecA(), 3);
  expect(hits[0].distance <= hits[1].distance);
  expect(hits[1].distance <= hits[2].distance);
  expect(hits[0].score >= hits[1].score);
});

test("a hit carries the chunk's text, source and metadata", () => {
  seed();
  let hits = pgSearch(TABLE, vecB(), 1);
  expect(hits[0].id == "b");
  expect(hits[0].text == "beta document");
  expect(hits[0].source == "two.txt");
  expect(hits[0].metadata == "lang=en");
});

test("k bounds the result", () => {
  seed();
  expect(pgSearch(TABLE, vecA(), 1).length == 1);
  expect(pgSearch(TABLE, vecA(), 2).length == 2);
  // Asking for more than exist returns what exists.
  expect(pgSearch(TABLE, vecA(), 99).length == 3);
});

test("a pgSearch is restricted to one source", () => {
  seed();
  let hits = pgSearchInSource(TABLE, vecA(), "one.txt", 5);
  expect(hits.length == 2);
  let i: int = 0;
  while (i < hits.length) {
    expect(hits[i].source == "one.txt");
    i = i + 1;
  }
});

test("a distance ceiling lets nothing match", () => {
  seed();
  // vecB is orthogonal to vecA: cosine distance 1, far outside a tight bound.
  let near = pgSearchWithin(TABLE, vecB(), 5, 0.01);
  expect(near.length == 1);
  expect(near[0].id == "b");
  // Nothing at all is within a bound this tight of an unrelated query.
  let v: number[] = [0.0, 0.0, 1.0];
  expect(pgSearchWithin(TABLE, v, 5, 0.05).length == 0);
});

test("searching an empty store yields nothing", () => {
  fresh();
  expect(pgSearch(TABLE, vecA(), 5).length == 0);
});

test("an empty query vector yields nothing", () => {
  seed();
  let none: number[] = [];
  expect(pgSearch(TABLE, none, 5).length == 0);
  expect(pgSearch(TABLE, vecA(), 0).length == 0);
});

test("an index can be built and pgSearch still works", () => {
  seed();
  expect(pgCreateIndex(TABLE, 1).ok);
  let hits = pgSearch(TABLE, vecA(), 1);
  expect(hits[0].id == "a");
  pgDropStore(TABLE);
  pgClose();
});

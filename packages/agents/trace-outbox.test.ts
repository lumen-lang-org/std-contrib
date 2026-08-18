import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, createTableSql, execute } from "../plume/plume.ts";
import { RecordedSpan, SpanAttr, Tracer, noTracer } from "../tracing/tracing.ts";
import { QueuedTrace, enqueueTrace, shipTraces } from "./trace-outbox.ts";
import { credentialsMapping } from "./schema.ts";

// A real sqlite file, the shape every suite here uses: the outbox table and
// nothing else, because shipTraces against a deployment with no tracing
// config is one of the cases under test.
let database: Db = sqlite();
let opened = false;

function fresh(): Db {
  if (!opened) {
    let cfg: DbConfig = { filename: "/tmp/agents_trace_outbox_test.db" };
    connectDatabase(database, cfg);
    opened = true;
  }
  execute(database, "DROP TABLE IF EXISTS trace_outbox");
  execute(database, "DROP TABLE IF EXISTS trace_config");
  execute(database, "DROP TABLE IF EXISTS credentials");
  execute(database, "CREATE TABLE trace_outbox (id TEXT NOT NULL, doc TEXT NOT NULL,"
    + " attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
  execute(database, "CREATE TABLE trace_config (id TEXT PRIMARY KEY, endpoint TEXT,"
    + " public_key TEXT, service_name TEXT, environment TEXT, enabled INTEGER, backend TEXT)");
  execute(database, createTableSql(database, credentialsMapping()));
  return database;
}

function spanned(): Tracer {
  let attrs: SpanAttr[] = [];
  let span: RecordedSpan = {
    traceId: "t-1", id: "s-1", parentId: "", name: "run",
    startNs: 1 as i64, endNs: 2 as i64, attrs: attrs,
    isError: false, statusMessage: "",
  };
  let spans: RecordedSpan[] = [span];
  let base = noTracer();
  let out: Tracer = {
    traceId: "t-1", spans: spans, endpoint: "http://127.0.0.1:1",
    backend: base.backend, serviceName: "test", environment: "test",
    sessionId: "th-1", userId: "u-1",
  };
  return out;
}

function outboxCount(db: Db): int {
  if (!db.query("SELECT COUNT(*) FROM trace_outbox", [])) {
    return -1;
  }
  return parseInt(db.value(0, 0), 10) ?? -1;
}

test("a queued trace is a row holding identity and spans, and never an endpoint or a key", () => {
  let db = fresh();
  expect(enqueueTrace(db, spanned()) == "");
  expect(outboxCount(db) == 1);
  db.query("SELECT doc FROM trace_outbox", []);
  let doc = db.value(0, 0);
  let row: QueuedTrace = JSON.parse<QueuedTrace>(doc);
  expect(row.traceId == "t-1");
  expect(row.sessionId == "th-1");
  expect(row.spans.length == 1 && row.spans[0].name == "run");
  expect(doc.indexOf("endpoint") < 0);
  expect(doc.indexOf("127.0.0.1") < 0);
});

test("a tracer with nothing recorded queues nothing", () => {
  let db = fresh();
  expect(enqueueTrace(db, noTracer()) == "");
  expect(outboxCount(db) == 0);
});

test("with tracing off, a pass drains the queue into the bin rather than into nowhere", () => {
  let db = fresh();
  expect(enqueueTrace(db, spanned()) == "");
  expect(shipTraces(db, "0123456789abcdef0123456789abcdef") == 0);
  expect(outboxCount(db) == 0);
});

test("a collector that does not answer costs a retry in the table, and ten of those the row", () => {
  let db = fresh();
  // An otlp backend pointed at a closed port: flush fails fast, nothing needs
  // a stored secret, and the row's journey through attempts is observable.
  execute(db, "INSERT INTO trace_config (id, endpoint, public_key, service_name,"
    + " environment, enabled, backend) VALUES ('default', 'http://127.0.0.1:9',"
    + " '', 'test', 'test', 1, 'otlp')");
  expect(enqueueTrace(db, spanned()) == "");

  expect(shipTraces(db, "0123456789abcdef0123456789abcdef") == 0);
  expect(outboxCount(db) == 1);
  db.query("SELECT attempts FROM trace_outbox", []);
  expect((parseInt(db.value(0, 0), 10) ?? -1) == 1);

  let pass: int = 0;
  while (pass < 9) {
    shipTraces(db, "0123456789abcdef0123456789abcdef");
    pass = pass + 1;
  }
  expect(outboxCount(db) == 0);
});

// Which tracer a row asks for, and the four ways to be off.
//
// The sending itself is the tracing package's, tested there. What is decided
// here is whether tracing happens at all and where it goes — and getting that
// wrong is not loud: a run either sends nothing and nobody notices, or sends
// to the wrong collector with the wrong credential.
//
//   cd packages/agents && lumen test trace.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable, createTableSql } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { credentialsMapping } from "./schema.ts";
import { storeCredential } from "./credentials.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "./trace.ts";

// Long enough to be a real AES-256 key. Nothing here decrypts anything a test
// did not encrypt first.
const MASTER: string = "0123456789abcdef0123456789abcdef";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_trace_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS trace_config");
  dropTable(database, credentialsMapping());
  migrate(database, tracePlan(database));
  execute(database, createTableSql(database, credentialsMapping()));
}

function config(backend: string, endpoint: string, enabled: bool): TraceConfigRow {
  let row: TraceConfigRow = {
    id: "default", backend: backend, endpoint: endpoint, publicKey: "pk-lf-1",
    serviceName: "", environment: "", enabled: enabled,
  };
  return row;
}

function save(row: TraceConfigRow): void {
  persist(database, traceConfigMapping(), JSON.stringify(row));
}

function withSecret(): void {
  storeCredential(database, { provider: "tracing", apiKey: "sk-lf-secret", masterKey: MASTER, now: "2026-07-26T00:00:00Z" });
}

// --- the four ways to be off ----------------------------------------------------------

test("no row at all is off, and is not an error", () => {
  // A deployment that has not configured a collector is not misconfigured.
  // Refusing to run would be absurd.
  fresh();
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "");
  expect(t.backend.name == "none");
});

test("a disabled row is off", () => {
  fresh();
  withSecret();
  save(config("langfuse", "https://cloud.langfuse.com/api/public/otel/v1/traces", false));
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "");
});

test("a row with no endpoint is off", () => {
  fresh();
  withSecret();
  save(config("langfuse", "", true));
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "");
});

test("langfuse with no stored secret is off rather than unauthenticated", () => {
  // Langfuse always needs one. Sending without it means every span is
  // rejected, which looks exactly like tracing being broken.
  fresh();
  save(config("langfuse", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "");
});

test("a collector wanting no credential still traces", () => {
  // A plain OTLP endpoint on a private network needs nothing. Requiring a
  // secret there would make the common local case impossible.
  fresh();
  save(config("otlp", "http://127.0.0.1:4318/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "http://127.0.0.1:4318/v1/traces");
  expect(t.backend.name == "otlp");
});

test("an unknown backend name is off, not guessed at", () => {
  fresh();
  withSecret();
  save(config("datadog-ish", "https://example.test/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.endpoint == "");
  expect(t.backend.name == "none");
});

// --- what the row selects -------------------------------------------------------------

test("the row names the backend rather than the endpoint implying it", () => {
  fresh();
  withSecret();
  save(config("langfuse", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.backend.name == "langfuse");
  expect(t.endpoint == "https://cloud.langfuse.com/api/public/otel/v1/traces");
  // A trace id exists from the start; spans join it as the run goes.
  expect(t.traceId.length == 32);
  expect(t.spans.length == 0);
});

test("an endpoint that looks like one vendor is served by the named one", () => {
  // Sniffing the URL is a guess. A deployment that says "otlp" and points at
  // a Langfuse host gets a plain OTLP tracer, and that is the point.
  fresh();
  withSecret();
  save(config("otlp", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.backend.name == "otlp");
});

test("a row written before backends were named is read as langfuse", () => {
  // The empty column predates the choice, and it was Langfuse — that is all
  // this package could talk to then. Those deployments keep working.
  fresh();
  withSecret();
  save(config("", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.backend.name == "langfuse");
});

test("an unset service name gets a default, so spans do not group under nothing", () => {
  fresh();
  save(config("otlp", "http://127.0.0.1:4318/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.serviceName == "lumen-agents");
  // The environment defaults to "production" rather than to nothing: a
  // collector filters on it, and spans labelled with an empty string are
  // findable under no filter at all.
  expect(t.environment == "production");
});

test("the service name and environment reach the tracer", () => {
  fresh();
  let row = config("otlp", "http://127.0.0.1:4318/v1/traces", true);
  let named: TraceConfigRow = {
    id: row.id, backend: row.backend, endpoint: row.endpoint, publicKey: row.publicKey,
    serviceName: "checkout-agents", environment: "staging", enabled: true,
  };
  save(named);
  let t = tracerFor(database, MASTER);
  expect(t.serviceName == "checkout-agents");
  expect(t.environment == "staging");
});

// --- the secret -----------------------------------------------------------------------

test("the secret comes from the encrypted store, not from this table", () => {
  // A secret stored beside the thing it authenticates is decoration. The row
  // holds the public key; the secret goes through the same envelope as a
  // provider's API key.
  fresh();
  withSecret();
  save(config("langfuse", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, MASTER);
  expect(t.backend.authValue.length > 0);
  // The public key is the row's.
  expect(t.backend.authValue.indexOf("sk-lf-secret") < 0);
});

test("the wrong master key leaves tracing off rather than sending a broken credential", () => {
  fresh();
  withSecret();
  save(config("langfuse", "https://cloud.langfuse.com/api/public/otel/v1/traces", true));
  let t = tracerFor(database, "ffffffffffffffffffffffffffffffff");
  expect(t.endpoint == "");
});

// --- taking effect without a restart --------------------------------------------------

test("changing the row changes the next tracer", () => {
  // The reason this is a table and not an environment variable: a change takes
  // effect on the next request.
  fresh();
  save(config("otlp", "http://127.0.0.1:4318/v1/traces", true));
  expect(tracerFor(database, MASTER).backend.name == "otlp");

  save(config("otlp", "http://127.0.0.1:4318/v1/traces", false));
  expect(tracerFor(database, MASTER).endpoint == "");
});

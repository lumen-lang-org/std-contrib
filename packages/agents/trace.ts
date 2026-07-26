// Where a run's trace goes, configured by a row.
//
//   let tracer = tracerFor(db, masterKey());   // off unless a row says otherwise
//
// Tracing is optional and off by default. A deployment that has not configured
// a collector runs exactly as before: `tracerFor` hands back a tracer that
// records nothing and sends nothing, and every call site threads it without
// asking whether it is real.
//
// The endpoint, the public key and the service name are a row, so pointing a
// deployment at a different collector is an UPDATE. The *secret* key is not a
// row in this table: it goes through the same encrypted credential store as a
// provider's API key, under the provider name "tracing", because a secret
// stored beside the thing it authenticates is decoration.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, field, repository, findById, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { Tracer, makeTracerFor, tracerWithEnvironment, noTracer } from "../tracing/tracing.ts";
import { backendNamed } from "../tracing/backend.ts";
import { credentialFor } from "./credentials.ts";

// There is one of these, keyed "default". A table rather than a constant
// because it is configuration like everything else here — and a table rather
// than an environment variable because the point of this package is that a
// change takes effect on the next request without a restart.
export type TraceConfigRow = {
  id: string,
  // Which backend this is: "langfuse", "otlp", or anything the tracing package
  // learns later. Named rather than sniffed from the endpoint — a URL suffix
  // is a guess, and a deployment that knows what it is running should say so.
  backend: string,
  // The collector's trace URL. For Langfuse, `/api/public/otel/v1/traces` on
  // whichever instance.
  endpoint: string,
  publicKey: string,
  // What the collector files these traces under, and which environment they
  // came from — "production", "staging", whatever a deployment calls itself.
  serviceName: string,
  environment: string,
  enabled: bool,
};

export function traceConfigMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("backend", "backend", "text"),
    field("endpoint", "endpoint", "text"),
    field("publicKey", "public_key", "text"),
    field("serviceName", "service_name", "text"),
    field("environment", "environment", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("trace_config", "id", "id", fs);
}

// The mapping as migration 14 wrote it.
//
// Frozen on purpose. A migration's checksum is over its SQL, so generating
// step 14 from a mapping that later grows would change its checksum and be
// refused by every database that already ran it. The live mapping above is
// free to grow; this one records what was actually created, and each new
// column arrives as its own step.
//
// That is the answer to a question this package has been dodging: generated
// CREATEs and an append-only history can coexist, as long as the generator a
// past step used stops changing.
function traceConfigMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("endpoint", "endpoint", "text"),
    field("publicKey", "public_key", "text"),
    field("serviceName", "service_name", "text"),
    field("environment", "environment", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository("trace_config", "id", "id", fs);
}

// Appended to the same plan as everything else; a second migrate() call would
// be handed a plan missing the recorded versions and refuse.
export function tracePlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("14", "trace config", createTableSql(db, traceConfigMappingV1())),
    migration("15", "trace backend",
      "ALTER TABLE trace_config ADD COLUMN backend " + db.textType),
  ];
  return plan;
}

// The tracer a run should use, or one that does nothing.
//
// Four ways to be off, and none of them is an error: no row, a row that is
// disabled, a row with no endpoint, or no secret key stored. A deployment that
// has not set tracing up is not misconfigured, and refusing to run would be
// absurd — so this reports nothing and returns a tracer that sends nothing.
export function tracerFor(db: Db, master: string): Tracer {
  let document = findById(db, traceConfigMapping(), "default");
  if (document == "") { return noTracer(); }
  let row: TraceConfigRow = JSON.parse<TraceConfigRow>(document);
  if (!row.enabled || row.endpoint == "") { return noTracer(); }

  // The secret is read the same way a provider's key is: out of the encrypted
  // store, never out of this table.
  //
  // A collector wanting no credential is not a misconfiguration, so an empty
  // secret only stops a backend that needs one. Langfuse always does.
  let secret = credentialFor(db, "tracing", master);
  let name = backendNameOf(row);
  if (secret == "" && name == "langfuse") { return noTracer(); }

  let backend = backendNamed(name, row.endpoint, row.publicKey, secret);
  if (backend.name == "none") { return noTracer(); }

  let t = makeTracerFor(backend, row.endpoint, serviceNameOr(row));
  if (row.environment == "") { return t; }
  return tracerWithEnvironment(t, row.environment);
}

// A row written before backends were named has an empty column, and it was
// Langfuse — that is the only thing this package could talk to then. Reading
// it as Langfuse keeps those deployments working; writing the column is what
// the API does now.
function backendNameOf(row: TraceConfigRow): string {
  if (row.backend == "") { return "langfuse"; }
  return row.backend;
}

// A collector groups by service name, and an empty one groups everything
// under nothing.
function serviceNameOr(row: TraceConfigRow): string {
  if (row.serviceName == "") { return "lumen-agents"; }
  return row.serviceName;
}

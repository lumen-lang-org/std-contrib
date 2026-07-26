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
import { Tracer, makeTracer, tracerWithEnvironment, noTracer } from "../tracing/tracing.ts";
import { credentialFor } from "./credentials.ts";

// There is one of these, keyed "default". A table rather than a constant
// because it is configuration like everything else here — and a table rather
// than an environment variable because the point of this package is that a
// change takes effect on the next request without a restart.
export type TraceConfigRow = {
  id: string,
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
    migration("14", "trace config", createTableSql(db, traceConfigMapping())),
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
  let secret = credentialFor(db, "tracing", master);
  if (secret == "") { return noTracer(); }

  let t = makeTracer(row.endpoint, row.publicKey, secret, serviceNameOr(row));
  if (row.environment == "") { return t; }
  return tracerWithEnvironment(t, row.environment);
}

// A collector groups by service name, and an empty one groups everything
// under nothing.
function serviceNameOr(row: TraceConfigRow): string {
  if (row.serviceName == "") { return "lumen-agents"; }
  return row.serviceName;
}

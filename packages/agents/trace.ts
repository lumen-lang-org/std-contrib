import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, field, repository, findById, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { Tracer, makeTracerFor, tracerWithEnvironment, noTracer } from "../tracing/tracing.ts";
import { BackendCredentials, backendNamed } from "../tracing/backend.ts";
import { credentialFor } from "./credentials.ts";
import { traceConfigRepository } from "./routes/tracing/entities/trace-config.entity.ts";

export type TraceConfigRow = {
  id: string,
  backend: string,
  endpoint: string,
  publicKey: string,
  serviceName: string,
  environment: string,
  enabled: bool,
};

export function traceConfigMapping(): DbRepository {
  return traceConfigRepository();
}

function traceConfigMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("endpoint", "endpoint", "text"),
    field("publicKey", "public_key", "text"),
    field("serviceName", "service_name", "text"),
    field("environment", "environment", "text"),
    field("enabled", "enabled", "bool"),
  ];
  return repository({ table: "trace_config", idField: "id", idColumn: "id", fields: fs });
}

export function tracePlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("14", "trace config", createTableSql(db, traceConfigMappingV1())),
    migration("15", "trace backend",
      "ALTER TABLE trace_config ADD COLUMN backend " + db.textType),
  ];
  return plan;
}

export function tracerFor(db: Db, master: string): Tracer {
  let document = findById(db, traceConfigMapping(), "default");
  if (document == "") {
    return noTracer();
  }
  let row: TraceConfigRow = JSON.parse<TraceConfigRow>(document);
  if (!row.enabled || row.endpoint == "") {
    return noTracer();
  }

  let secret = credentialFor(db, "tracing", master);
  let name = backendNameOf(row);
  if (secret == "" && name == "langfuse") {
    return noTracer();
  }

  let creds: BackendCredentials = {
    endpoint: row.endpoint,
    identity: row.publicKey,
    secret: secret,
  };
  let backend = backendNamed(name, creds);
  if (backend.name == "none") {
    return noTracer();
  }

  let t = makeTracerFor(backend, row.endpoint, serviceNameOr(row));
  if (row.environment == "") {
    return t;
  }
  return tracerWithEnvironment(t, row.environment);
}

function backendNameOf(row: TraceConfigRow): string {
  if (row.backend == "") {
    return "langfuse";
  }
  return row.backend;
}

function serviceNameOr(row: TraceConfigRow): string {
  if (row.serviceName == "") {
    return "lumen-agents";
  }
  return row.serviceName;
}

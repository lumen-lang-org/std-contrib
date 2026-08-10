import { Db } from "../../../plume/driver.ts";
import { findById, persist } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, notFound, okJson, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DestinationMove, credentialFor, destinationProblem, forgetCredential, hasCredential, masterKey, masterKeyProblem, storeCredential } from "../../credentials.ts";
import { backendOr, knownBackend } from "../../payload.ts";
import { TraceConfigRow, traceConfigMapping } from "../../trace.ts";
import { TraceSecret, TraceStatus, TraceStatusOff } from "./types.ts";

export function traceDestinationProblem(db: Db, row: TraceConfigRow): string {
  let held = findById(db, traceConfigMapping(), "default");
  let was = "";
  if (held != "") { was = JSON.parse<TraceConfigRow>(held).endpoint; }
  let move: DestinationMove = {
    subject: "the trace collector",
    secretName: "its secret key",
    clearWith: "DELETE /tracing/key",
    was: was,
    now: row.endpoint,
    secretStored: hasCredential(db, "tracing"),
  };
  return destinationProblem(move);
}

@controller("/tracing")
export class TraceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  status(req: Request): Reply {
    let document = findById(this.db, traceConfigMapping(), "default");
    if (document == "") {
      let off: TraceStatusOff = { configured: false, active: false };
      return okJson(off);
    }
    let row: TraceConfigRow = JSON.parse<TraceConfigRow>(document);
    let hasSecret = credentialFor(this.db, "tracing", this.master) != "";
    let v: TraceStatus = {
      configured: true,
      active: tracing(tracerFor(this.db, this.master)),
      backend: backendOr(row.backend),
      endpoint: row.endpoint,
      publicKey: row.publicKey,
      serviceName: row.serviceName,
      environment: row.environment,
      enabled: row.enabled,
      secretStored: hasSecret,
    };
    return okJson(v);
  }

  @put("/")
  configure(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let body: TraceConfigRow = JSON.parse<TraceConfigRow>(req.body);
    if (body.enabled && body.endpoint == "") {
      return badRequest("tracing cannot be enabled without an endpoint");
    }
    if (!knownBackend(backendOr(body.backend))) {
      return badRequest("unknown backend \"" + body.backend + "\"; this understands langfuse, otlp, phoenix, braintrust, langsmith and arize");
    }
    let moved = traceDestinationProblem(this.db, body);
    if (moved != "") { return badRequest(moved); }
    let row: TraceConfigRow = {
      id: "default",
      backend: backendOr(body.backend),
      endpoint: body.endpoint,
      publicKey: body.publicKey,
      serviceName: body.serviceName,
      environment: body.environment,
      enabled: body.enabled,
    };
    let written = persist(this.db, traceConfigMapping(), JSON.stringify(row));
    if (!written.ok) { return badRequest(written.error); }
    return this.status(req);
  }

  @put("/key")
  setKey(req: Request): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") { return badRequest(problem); }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: TraceSecret = JSON.parse<TraceSecret>(req.body);
    let stored = storeCredential(this.db, { provider: "tracing", apiKey: body.secretKey, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return this.status(req);
  }

  @del("/key")
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, "tracing")) {
      return notFound("a tracing key");
    }
    return this.status(req);
  }
}

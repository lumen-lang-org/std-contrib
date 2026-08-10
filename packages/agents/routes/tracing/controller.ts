import { Db } from "../../../plume/driver.ts";
import { findById, persist } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, NotFound, OkJson, Refused } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { DestinationMove, credentialFor, destinationProblem, forgetCredential, hasCredential, masterKey, masterKeyProblem, storeCredential } from "../../credentials.ts";
import { backendOr, knownBackend } from "../../payload.ts";
import { TraceConfigRow, traceConfigMapping } from "../../trace.ts";
import { TraceSecret, TraceStatus, TraceStatusOff } from "./types.ts";

export function traceDestinationProblem(db: Db, row: TraceConfigRow): string {
  let held = findById(db, traceConfigMapping(), "default");
  let was = "";
  if (held != "") {
    was = JSON.parse<TraceConfigRow>(held).endpoint;
  }
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
@bindings
export class TraceApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  status(req: Request): Reply {
    let document = findById(this.db, traceConfigMapping(), "default");
    if (document == "") {
      let off: TraceStatusOff = { configured: false, active: false };
      return OkJson(off);
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
    return OkJson(v);
  }

  @Put("/")
  configure(req: Request): Reply {
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let body: TraceConfigRow = JSON.parse<TraceConfigRow>(req.body);
    if (body.enabled && body.endpoint == "") {
      return BadRequest("tracing cannot be enabled without an endpoint");
    }
    if (!knownBackend(backendOr(body.backend))) {
      return BadRequest("unknown backend \"" + body.backend + "\"; this understands langfuse, otlp, phoenix, braintrust, langsmith and arize");
    }
    let moved = traceDestinationProblem(this.db, body);
    if (moved != "") {
      return BadRequest(moved);
    }
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
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return this.status(req);
  }

  @Put("/key")
  setKey(req: Request): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") {
      return BadRequest(problem);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let body: TraceSecret = JSON.parse<TraceSecret>(req.body);
    let stored = storeCredential(this.db, { provider: "tracing", apiKey: body.secretKey, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return BadRequest(stored);
    }
    return this.status(req);
  }

  @Delete("/key")
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, "tracing")) {
      return NotFound("a tracing key");
    }
    return this.status(req);
  }
}

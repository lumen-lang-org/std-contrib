import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { tracing } from "../../../../tracing/tracing.ts";
import { stamp } from "../../../api-core.ts";
import { DestinationMove, credentialFor, destinationFault, forgetCredential, hasCredential, masterKeyFault, storeCredential } from "../../../credentials.ts";
import { backendOr, knownBackend } from "../../../payload.ts";
import { tracerFor } from "../../../trace.ts";
import { TraceConfigRow } from "./entities/trace-config.entity.ts";
import { TraceSecret } from "./dtos/trace-secret.dto.ts";
import { TraceStatus } from "./dtos/trace-status.dto.ts";
import { TraceStatusOff } from "./dtos/trace-status-off.dto.ts";
import { TraceRepository } from "./trace.repository.ts";

export class TraceService {
  repository: TraceRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new TraceRepository(database);
    this.master = master;
  }

  status(): string {
    let document = this.repository.one();
    if (document == "") {
      let off: TraceStatusOff = { configured: false, active: false };
      return JSON.stringify(off);
    }
    let row: TraceConfigRow = JSON.parse<TraceConfigRow>(document);
    let hasSecret = credentialFor(this.repository.database, "tracing", this.master) != "";
    let view: TraceStatus = {
      configured: true,
      active: tracing(tracerFor(this.repository.database, this.master)),
      backend: backendOr(row.backend),
      endpoint: row.endpoint,
      publicKey: row.publicKey,
      serviceName: row.serviceName,
      environment: row.environment,
      enabled: row.enabled,
      secretStored: hasSecret,
    };
    return JSON.stringify(view);
  }

  movedFault(row: TraceConfigRow): string {
    let held = this.repository.one();
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
      secretStored: hasCredential(this.repository.database, "tracing"),
    };
    return destinationFault(move);
  }

  configure(body: string): Outcome {
    if (body == "") {
      return refusing("a body is required");
    }
    let row: TraceConfigRow = JSON.parse<TraceConfigRow>(body);
    if (row.enabled && row.endpoint == "") {
      return refusing("tracing cannot be enabled without an endpoint");
    }
    if (!knownBackend(backendOr(row.backend))) {
      return refusing("unknown backend \"" + row.backend + "\"; this understands langfuse, otlp, phoenix, braintrust, langsmith and arize");
    }
    let moved = this.movedFault(row);
    if (moved != "") {
      return refusing(moved);
    }
    let saved: TraceConfigRow = {
      id: "default",
      backend: backendOr(row.backend),
      endpoint: row.endpoint,
      publicKey: row.publicKey,
      serviceName: row.serviceName,
      environment: row.environment,
      enabled: row.enabled,
    };
    let written = this.repository.save(saved);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.status());
  }

  setKey(body: string): Outcome {
    let fault = masterKeyFault(this.master);
    if (fault != "") {
      return refusing(fault);
    }
    if (body == "") {
      return refusing("a body is required");
    }
    let secret: TraceSecret = JSON.parse<TraceSecret>(body);
    let stored = storeCredential(this.repository.database, {
      provider: "tracing",
      apiKey: secret.secretKey,
      masterKey: this.master,
      now: stamp(),
    });
    if (stored != "") {
      return refusing(stored);
    }
    return produced(this.status());
  }

  clearKey(): bool {
    return forgetCredential(this.repository.database, "tracing");
  }
}

export function traceDestinationFault(database: Db, row: TraceConfigRow): string {
  return new TraceService(database, "").movedFault(row);
}

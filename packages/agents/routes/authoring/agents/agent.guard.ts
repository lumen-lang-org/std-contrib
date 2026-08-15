import { Guarded, Request, NotFound, param, resolve, Respond, reject } from "../../../../rest/server.ts";
import { GUEST_DAILY_RUNS, callerTags, guestQuotaJson, guestTag } from "../../../api-core.ts";
import { nextUtcMidnightIso, secondsToUtcMidnight } from "../../../usage.ts";
import { AgentService } from "./agent.service.ts";

export function agentExists(agents: AgentService, request: Request): Guarded {
  let id = param(request, "id");
  if (!agents.exists(id)) {
    return reject(NotFound("agent " + id));
  }
  return resolve();
}

export function guestRunsLeft(agents: AgentService, request: Request): Guarded {
  let guest = guestTag(callerTags(request));
  if (guest == "") {
    return resolve();
  }
  let atGate = Date.now();
  let used = agents.runsToday(guest, atGate);
  if (used < 0) {
    // Closed rather than open: an allowance that cannot be read is not an
    // allowance of none used.
    return reject(Respond(503, "{\"error\":\"the guest allowance could not be read\"}",
      "application/json"));
  }
  if (used < GUEST_DAILY_RUNS) {
    return resolve();
  }
  let refusal = Respond(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
  refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
  return reject(refusal);
}

import { Guarded, Request, NotFound, param, resolve, Respond, reject } from "../../../../rest/server.ts";
import { OWNED_AGENT, ownerOfRow } from "../../../owner.ts";
import { GUEST_DAILY_RUNS, callerTags, filingAs, guestQuotaJson, guestTag } from "../../../api-core.ts";
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

/** Whose agent it is.
 *
 *  Existence was the only question while every agent was the deployment's. Now
 *  that anybody may write one, a PUT or a DELETE that names somebody else's id
 *  has to be refused rather than applied — and the deployment's own rows are
 *  reachable only by filing as the deployment, which the console allows to
 *  operators alone. */
export function agentOwned(agents: AgentService, request: Request): Guarded {
  let id = param(request, "id");
  if (!agents.exists(id)) {
    return reject(NotFound("agent " + id));
  }
  if (ownerOfRow(agents.repository.database, OWNED_AGENT, id) != filingAs(request)) {
    return reject(Respond(403, "{\"error\":\"that agent is not yours\"}", "application/json"));
  }
  return resolve();
}

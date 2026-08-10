import { Guarded, Request, NotFound, param, passes, Respond, stops } from "../../../rest/server.ts";
import { GUEST_DAILY_RUNS, callerTags, guestQuotaJson, guestTag } from "../../api-core.ts";
import { nextUtcMidnightIso, secondsToUtcMidnight } from "../../usage.ts";
import { AgentService } from "./agent.service.ts";

// The check fifteen handlers used to open with. As a guard it runs before the
// handler is entered, so a missing agent is one sentence in one place.
export function agentExists(agents: AgentService, req: Request): Guarded {
  let id = param(req, "id");
  if (!agents.exists(id)) {
    return stops(NotFound("agent " + id));
  }
  return passes();
}

// A guest gets a fixed number of runs a day, and is told when it resets.
export function guestRunsLeft(agents: AgentService, req: Request): Guarded {
  let guest = guestTag(callerTags(req));
  if (guest == "") {
    return passes();
  }
  let atGate = Date.now();
  let used = agents.runsToday(guest, atGate);
  if (used < GUEST_DAILY_RUNS) {
    return passes();
  }
  let refusal = Respond(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
  refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
  return stops(refusal);
}

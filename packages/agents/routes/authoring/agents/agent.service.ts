import { Db } from "../../../../plume/driver.ts";
import { OWNED_AGENT, ownRow } from "../../../owner.ts";
import { traceId, tracerWithMoreSpans, tracing } from "../../../../tracing/tracing.ts";
import { enqueueTrace } from "../../../trace-outbox.ts";
import { AgentRetrievalRow } from "../../../knowledge.ts";
import { runAgentFor } from "../../../run.ts";
import { recordRun } from "../../../runlog.ts";
import { tracerFor } from "../../../trace.ts";
import { runsSince, utcDayStartText } from "../../../usage.ts";
import { Model } from "../../inference/models/entities/model.entity.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { AgentBody } from "./dtos/agent-body.dto.ts";
import { RetrievalSetup } from "./dtos/retrieval-setup.dto.ts";
import { RunResult } from "./dtos/run-result.dto.ts";
import { AgentRepository } from "./agent.repository.ts";
import { runResultOf } from "./agent.utils.ts";

export class AgentService {
  repository: AgentRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new AgentRepository(database);
    this.master = master;
  }

  listing(owner: string, enabledOnly: bool, onlyMine: bool): string {
    return this.repository.listing(owner, enabledOnly, onlyMine);
  }

  one(id: string): string {
    return this.repository.one(id);
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  scopes(id: string): string[] {
    return this.repository.scopes(id);
  }

  runs(id: string, tags: string[], limit: int): string {
    return this.repository.runs(id, tags, limit);
  }

  forget(id: string): Outcome {
    let fault = this.repository.forget(id);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }

  runsToday(guest: string, at: number): int {
    return runsSince(this.repository.database, guest, utcDayStartText(at));
  }

  create(owner: string, body: AgentBody): Outcome {
    if (this.repository.exists(body.id)) {
      return refusing("\"" + body.id + "\" already exists; a POST creates, and changing a row is a PUT");
    }
    let wrong = this.pointsAtSomething(body);
    if (wrong != "") {
      return refusing(wrong);
    }
    if (body.isDefault) {
      let cleared = this.repository.clearDefaults();
      if (!cleared.ok) {
        return refusing(cleared.error);
      }
    }
    let written = this.repository.save(JSON.stringify(body));
    if (!written.ok) {
      return refusing(written.error);
    }
    if (!ownRow(this.repository.database, OWNED_AGENT, body.id, owner)) {
      return refusing("the agent was written but could not be filed under an owner");
    }
    return produced(this.repository.one(body.id));
  }

  update(id: string, body: AgentBody): Outcome {
    if (body.id != id) {
      return refusing("the id in the body must match the path");
    }
    let wrong = this.pointsAtSomething(body);
    if (wrong != "") {
      return refusing(wrong);
    }
    if (body.isDefault) {
      let cleared = this.repository.clearDefaults();
      if (!cleared.ok) {
        return refusing(cleared.error);
      }
    }
    let written = this.repository.save(JSON.stringify(body));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  pointsAtSomething(body: AgentBody): string {
    if (!this.repository.hasModelConfig(body.modelConfigId)) {
      return "no model config " + body.modelConfigId;
    }
    if (!this.repository.hasPrompt(body.promptId)) {
      return "no prompt " + body.promptId;
    }
    return "";
  }

  attachServer(id: string, serverId: string): Outcome {
    if (!this.repository.hasServer(serverId)) {
      return refusing("no server " + serverId);
    }
    let linked = this.repository.linkServer(id, serverId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repository.one(id));
  }

  detachServer(id: string, serverId: string): Outcome {
    let gone = this.repository.unlinkServer(id, serverId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repository.one(id));
  }

  attachChild(id: string, childId: string): Outcome {
    if (!this.repository.exists(childId)) {
      return refusing("no agent " + childId);
    }
    if (childId == id) {
      return refusing("an agent cannot be its own sub-agent");
    }
    let linked = this.repository.linkChild(id, childId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repository.one(id));
  }

  detachChild(id: string, childId: string): Outcome {
    let gone = this.repository.unlinkChild(id, childId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repository.one(id));
  }

  attachSkill(id: string, skillId: string): Outcome {
    if (!this.repository.hasSkill(skillId)) {
      return refusing("no skill " + skillId);
    }
    let linked = this.repository.linkSkill(id, skillId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repository.one(id));
  }

  detachSkill(id: string, skillId: string): Outcome {
    let gone = this.repository.unlinkSkill(id, skillId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repository.one(id));
  }

  grant(id: string, scope: string): Outcome {
    let fault = this.repository.grant(id, scope);
    if (fault != "") {
      return refusing(fault);
    }
    return produced(JSON.stringify(this.repository.scopes(id)));
  }

  revoke(id: string, scope: string): Outcome {
    let fault = this.repository.revoke(id, scope);
    if (fault != "") {
      return refusing(fault);
    }
    return produced(JSON.stringify(this.repository.scopes(id)));
  }

  setRetrieval(id: string, body: RetrievalSetup): Outcome {
    if (!this.repository.embeddingUsable(body.embeddingModelId)) {
      return refusing("no usable embedding model " + body.embeddingModelId);
    }
    let row: AgentRetrievalRow = {
      agentId: id,
      embeddingModelId: body.embeddingModelId,
      topK: body.topK,
      maxDistance: body.maxDistance,
      enabled: body.enabled,
    };
    let written = this.repository.saveRetrieval(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.retrieval(id));
  }

  run(id: string, text: string, owner: string): RunResult {
    let tracer = tracerFor(this.repository.database, this.master);
    let answered = runAgentFor(this.repository.database, id, text, this.master, owner, tracer);

    let runId = recordRun(this.repository.database, {
      agentId: id, threadId: "", owner: owner,
      question: text, run: answered, modelChoiceId: "", routeNote: "",
    });

    /* Queued, never flushed here — the same trade thread.service.ts makes, for
     * the same measured reason: the upload sat between the finished answer and
     * the reply carrying it. Measured on staging, an identical 3-round run took
     * 53s with the flush inline and 16s with it queued, while the collector
     * itself answers in 13ms. The wait was never the network. */
    let traced = "";
    if (tracing(tracer) && answered.spans.length > 0) {
      let queued = enqueueTrace(this.repository.database,
        tracerWithMoreSpans(tracer, answered.spans));
      if (queued == "") {
        traced = traceId(tracer);
      } else {
        console.error("trace outbox: a trace could not be queued — " + queued);
      }
    }
    return runResultOf(runId, answered, traced);
  }
}

export function forgetAgent(database: Db, agentId: string): void {
  new AgentRepository(database).forget(agentId);
}

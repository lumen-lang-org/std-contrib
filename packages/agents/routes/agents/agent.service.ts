import { Db } from "../../../plume/driver.ts";
import { flush, traceId, tracerWithMoreSpans, tracing } from "../../../tracing/tracing.ts";
import { AgentRetrievalRow } from "../../knowledge.ts";
import { runAgentTraced } from "../../run.ts";
import { recordRun } from "../../runlog.ts";
import { tracerFor } from "../../trace.ts";
import { runsSince, utcDayStartText } from "../../usage.ts";
import { AgentWebRagRow } from "../../webrag.ts";
import { Model } from "../models/entities/model.entity.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { AgentBody } from "./dtos/agent-body.dto.ts";
import { RetrievalSetup } from "./dtos/retrieval-setup.dto.ts";
import { RunResult } from "./dtos/run-result.dto.ts";
import { WebRagSetup } from "./dtos/web-rag-setup.dto.ts";
import { AgentRepository } from "./agent.repository.ts";
import { runResultOf } from "./agent.utils.ts";

export class AgentService {
  repository: AgentRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new AgentRepository(database);
    this.master = master;
  }

  listing(enabledOnly: bool): string {
    return this.repository.listing(enabledOnly);
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

  webRag(id: string): AgentWebRagRow {
    return this.repository.webRag(id);
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

  create(body: AgentBody): Outcome {
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

  setWebRag(id: string, body: WebRagSetup): Outcome {
    if (body.queryMode == "generated") {
      let document = this.repository.model(body.queryModelId);
      if (document == "") {
        return refusing("queryMode generated needs an existing chat model as queryModelId");
      }
      let model: Model = JSON.parse<Model>(document);
      if (model.kind != "chat") {
        return refusing(model.label + " is not a chat model");
      }
    }
    let row: AgentWebRagRow = {
      agentId: id,
      enabled: body.enabled,
      topK: body.topK,
      maxChars: body.maxChars,
      queryMode: body.queryMode,
      queryModelId: body.queryModelId,
    };
    let written = this.repository.saveWebRag(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.storedWebRag(id));
  }

  run(id: string, text: string, owner: string): RunResult {
    let tracer = tracerFor(this.repository.database, this.master);
    let answered = runAgentTraced(this.repository.database, id, text, this.master, tracer);

    let runId = recordRun(this.repository.database, {
      agentId: id, threadId: "", owner: owner,
      question: text, run: answered, modelChoiceId: "", routeNote: "",
    });

    let traced = "";
    if (tracing(tracer) && answered.spans.length > 0) {
      let sent = flush(tracerWithMoreSpans(tracer, answered.spans));
      if (sent.ok) {
        traced = traceId(tracer);
      }
    }
    return runResultOf(runId, answered, traced);
  }
}

export function forgetAgent(database: Db, agentId: string): void {
  new AgentRepository(database).forget(agentId);
}

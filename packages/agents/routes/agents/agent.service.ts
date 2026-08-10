import { Db } from "../../../plume/driver.ts";
import { flush, traceId, tracerWithMoreSpans, tracing } from "../../../tracing/tracing.ts";
import { AgentRetrievalRow } from "../../knowledge.ts";
import { runAgentTraced } from "../../run.ts";
import { recordRun } from "../../runlog.ts";
import { ModelRow } from "../../schema.ts";
import { tracerFor } from "../../trace.ts";
import { runsSince, utcDayStartText } from "../../usage.ts";
import { AgentWebRagRow } from "../../webrag.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { AgentBody } from "./dtos/agent-body.dto.ts";
import { RetrievalSetup } from "./dtos/retrieval-setup.dto.ts";
import { RunResult } from "./dtos/run-result.dto.ts";
import { WebRagSetup } from "./dtos/web-rag-setup.dto.ts";
import { AgentRepository } from "./agent.repository.ts";
import { runResultOf } from "./agent.utils.ts";

// The rules about agents. It says what is wrong in a sentence and never in a
// status code — deciding that a refusal is a 400 rather than a 409 is the
// controller's job, which is what keeps this callable from a tool or a test.
export class AgentService {
  repo: AgentRepository;
  master: string;

  constructor(db: Db, master: string) {
    this.repo = new AgentRepository(db);
    this.master = master;
  }

  listing(enabledOnly: bool): string {
    return this.repo.listing(enabledOnly);
  }

  one(id: string): string {
    return this.repo.one(id);
  }

  exists(id: string): bool {
    return this.repo.exists(id);
  }

  scopes(id: string): string[] {
    return this.repo.scopes(id);
  }

  webRag(id: string): AgentWebRagRow {
    return this.repo.webRag(id);
  }

  runs(id: string, tags: string[], limit: int): string {
    return this.repo.runs(id, tags, limit);
  }

  forget(id: string): void {
    this.repo.forget(id);
  }

  runsToday(guest: string, at: number): int {
    return runsSince(this.repo.db, guest, utcDayStartText(at));
  }

  // A POST creates. The shape of the body is the DTO's business; that the id is
  // free, and that the config and prompt it points at exist, is this one's.
  create(body: AgentBody): Outcome {
    if (this.repo.exists(body.id)) {
      return refusing("\"" + body.id + "\" already exists; a POST creates, and changing a row is a PUT");
    }
    let wrong = this.pointsAtSomething(body);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repo.save(JSON.stringify(body));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repo.one(body.id));
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
      this.repo.clearDefaults();
    }
    let written = this.repo.save(JSON.stringify(body));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repo.one(id));
  }

  pointsAtSomething(body: AgentBody): string {
    if (!this.repo.hasModelConfig(body.modelConfigId)) {
      return "no model config " + body.modelConfigId;
    }
    if (!this.repo.hasPrompt(body.promptId)) {
      return "no prompt " + body.promptId;
    }
    return "";
  }

  attachServer(id: string, serverId: string): Outcome {
    if (!this.repo.hasServer(serverId)) {
      return refusing("no server " + serverId);
    }
    let linked = this.repo.linkServer(id, serverId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repo.one(id));
  }

  detachServer(id: string, serverId: string): Outcome {
    let gone = this.repo.unlinkServer(id, serverId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repo.one(id));
  }

  attachChild(id: string, childId: string): Outcome {
    if (!this.repo.exists(childId)) {
      return refusing("no agent " + childId);
    }
    if (childId == id) {
      return refusing("an agent cannot be its own sub-agent");
    }
    let linked = this.repo.linkChild(id, childId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repo.one(id));
  }

  detachChild(id: string, childId: string): Outcome {
    let gone = this.repo.unlinkChild(id, childId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repo.one(id));
  }

  attachSkill(id: string, skillId: string): Outcome {
    if (!this.repo.hasSkill(skillId)) {
      return refusing("no skill " + skillId);
    }
    let linked = this.repo.linkSkill(id, skillId);
    if (!linked.ok) {
      return refusing(linked.error);
    }
    return produced(this.repo.one(id));
  }

  detachSkill(id: string, skillId: string): Outcome {
    let gone = this.repo.unlinkSkill(id, skillId);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced(this.repo.one(id));
  }

  // Both answer with the scopes as they now stand, so the caller never has to
  // ask again to find out what it just changed.
  grant(id: string, scope: string): Outcome {
    let fault = this.repo.grant(id, scope);
    if (fault != "") {
      return refusing(fault);
    }
    return produced(JSON.stringify(this.repo.scopes(id)));
  }

  revoke(id: string, scope: string): Outcome {
    let fault = this.repo.revoke(id, scope);
    if (fault != "") {
      return refusing(fault);
    }
    return produced(JSON.stringify(this.repo.scopes(id)));
  }

  setRetrieval(id: string, body: RetrievalSetup): Outcome {
    if (!this.repo.embeddingUsable(body.embeddingModelId)) {
      return refusing("no usable embedding model " + body.embeddingModelId);
    }
    let row: AgentRetrievalRow = {
      agentId: id,
      embeddingModelId: body.embeddingModelId,
      topK: body.topK,
      maxDistance: body.maxDistance,
      enabled: body.enabled,
    };
    let written = this.repo.saveRetrieval(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repo.retrieval(id));
  }

  // The numeric bounds are the DTO's. What is left needs the database: a
  // generated query is asked of a model, so that model has to exist and chat.
  setWebRag(id: string, body: WebRagSetup): Outcome {
    if (body.queryMode == "generated") {
      let document = this.repo.model(body.queryModelId);
      if (document == "") {
        return refusing("queryMode generated needs an existing chat model as queryModelId");
      }
      let m: ModelRow = JSON.parse<ModelRow>(document);
      if (m.kind != "chat") {
        return refusing(m.label + " is not a chat model");
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
    let written = this.repo.saveWebRag(row);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repo.storedWebRag(id));
  }

  // Running an agent is one story: trace it, run it, file the run, and send the
  // spans if anything is listening.
  run(id: string, text: string, owner: string): RunResult {
    let tracer = tracerFor(this.repo.db, this.master);
    let answered = runAgentTraced(this.repo.db, id, text, this.master, tracer);

    let runId = recordRun(this.repo.db, {
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

// api.test.ts and the agent tools delete an agent without a controller in the
// picture, so the aggregate delete stays reachable as a function.
export function forgetAgent(db: Db, agentId: string): void {
  new AgentRepository(db).forget(agentId);
}

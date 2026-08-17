import { Db } from "../../../../plume/driver.ts";
import { findById } from "../../../../plume/plume.ts";
import { BadRequest, OkJson, Refused, Reply } from "../../../../rest/server.ts";
import { ModelChoiceRow, ModelConfigRow, configAndModel, modelChoicesMapping } from "../../../schema.ts";
import { choiceFault } from "../../../api-core.ts";
import { credentialFor, masterKey, masterKeyFault } from "../../../credentials.ts";
import { Completion, ToolSpec, Turn, completeTurns, replyText, userTurn } from "../../../provider.ts";
import { RunRecord, recordRun } from "../../../runlog.ts";
import { AgentRun } from "../../../run.ts";
import { CompletionAsk } from "./dtos/completion-ask.dto.ts";
import { CompletionView } from "./dtos/completion-view.dto.ts";

/* Headless inference: one prompt in, one answer out, against a model the
 * operator already configured. The first caller is Discover once it moves
 * out of this process; the shape is provider.complete()'s, reached the way
 * threads reach it — a model CHOICE from the operator's menu, or a config
 * named directly. No router on purpose: a router costs a second completion
 * per call to pick a model the caller here has already picked. */
export class CompletionService {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  answer(owner: string, ask: CompletionAsk): Reply {
    if (ask.input.trim() == "") {
      return BadRequest("an input is required: {\"modelChoiceId\":\"...\",\"input\":\"...\"}");
    }
    if (ask.modelChoiceId == "" && ask.modelConfigId == "") {
      return BadRequest("name a model: modelChoiceId (from /model-choices) or modelConfigId");
    }
    if (ask.modelChoiceId != "" && ask.modelConfigId != "") {
      return BadRequest("name one of modelChoiceId and modelConfigId, not both");
    }

    let configId = ask.modelConfigId;
    if (ask.modelChoiceId != "") {
      let refused = choiceFault(this.database, ask.modelChoiceId);
      if (refused != "") {
        return BadRequest(refused);
      }
      let held = findById(this.database, modelChoicesMapping(), ask.modelChoiceId);
      if (held == "") {
        return BadRequest("no model choice " + ask.modelChoiceId);
      }
      let choice: ModelChoiceRow = JSON.parse<ModelChoiceRow>(held);
      if (choice.configId == "") {
        return BadRequest("model choice " + ask.modelChoiceId
          + " routes between models; completions take a fixed model — name its modelConfigId directly");
      }
      configId = choice.configId;
    }

    let got = configAndModel(this.database, configId);
    if (got.fault != "") {
      return BadRequest(got.fault);
    }

    let master = masterKey();
    let unusable = masterKeyFault(master);
    if (unusable != "") {
      // The server's fault, not the caller's - and it must say so, not 400.
      return Refused(500, unusable);
    }
    let key = credentialFor(this.database, got.model.provider, master);
    if (key == "") {
      return BadRequest("no stored credential for provider \"" + got.model.provider + "\"");
    }

    // Records are immutable; an override is a new config, not an edit.
    let config = got.config;
    if (ask.maxTokens > 0) {
      let overridden: ModelConfigRow = {
        id: config.id, modelId: config.modelId, temperature: config.temperature,
        maxTokens: ask.maxTokens, topP: config.topP, extra: config.extra,
        thinking: config.thinking, label: config.label,
        selectable: config.selectable, rank: config.rank,
      };
      config = overridden;
    }

    let turns: Turn[] = [userTurn(ask.input)];
    let noTools: ToolSpec[] = [];
    let answered: Completion = completeTurns(got.model, config, ask.system, turns, noTools, key);

    /* Completion.text is the provider's raw wire body; the reply is inside
     * it, per provider. Extract before anything records or returns it —
     * discover and threads both learned this the same way. */
    let said = answered.ok ? replyText(got.model.provider, answered.text) : "";

    /* Both outcomes are recorded: a failed call spends the caller's time and
     * often the provider's tokens, and an unrecorded failure is exactly the
     * invisible spend this endpoint exists to end. */
    let runId = this.record(owner, ask, got.model.apiName, answered, said);

    if (!answered.ok) {
      return Refused(502, answered.error != "" ? answered.error : "the model did not answer");
    }
    let view: CompletionView = {
      ok: true,
      text: said,
      model: got.model.apiName,
      inputTokens: answered.inputTokens,
      outputTokens: answered.outputTokens,
      runId: runId,
    };
    return OkJson<CompletionView>(view);
  }

  record(owner: string, ask: CompletionAsk, modelApiName: string, answered: Completion, said: string): string {
    let noContext: Turn[] = [];
    let run: AgentRun = {
      ok: answered.ok, text: said, body: "", status: answered.status,
      agentName: "", promptVersion: 0, modelApiName: modelApiName,
      error: answered.error,
      inputTokens: answered.inputTokens, outputTokens: answered.outputTokens,
      context: noContext, steps: [], stopReason: answered.ok ? "end" : "error",
      rounds: 1, notes: [], calledTools: [], calledAgents: [], retrieved: [], spans: [],
    };
    let wrote: RunRecord = {
      agentId: "",
      threadId: "",
      owner: owner,
      question: ask.input,
      run: run,
      modelChoiceId: ask.modelChoiceId,
      routeNote: "completions",
    };
    return recordRun(this.database, wrote);
  }
}

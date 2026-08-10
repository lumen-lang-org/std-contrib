import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("runs")
export class Run {
  @id
  @column("id", "text")
  id: string;

  @column("agent_id", "text")
  agentId: string;

  @column("thread_id", "text")
  threadId: string;

  @column("owner", "text")
  owner: string;

  @column("input_tokens", "int")
  inputTokens: int;

  @column("output_tokens", "int")
  outputTokens: int;

  @column("model_choice_id", "text")
  modelChoiceId: string;

  @column("route_note", "text")
  routeNote: string;

  @column("agent_name", "text")
  agentName: string;

  @column("prompt_version", "int")
  promptVersion: int;

  @column("model_api_name", "text")
  modelApiName: string;

  @column("question", "text")
  question: string;

  @column("answer", "text")
  answer: string;

  @column("ok", "bool")
  ok: bool;

  @column("stop_reason", "text")
  stopReason: string;

  @column("rounds", "int")
  rounds: int;

  @column("error", "text")
  error: string;

  @column("created_at", "text")
  createdAt: string;

  @hasMany("run_steps", "id", "run_id",
           "step_index AS \"stepIndex\", tool, server, args, result, {bool:ok} AS \"ok\"")
  steps: string;

  constructor(id: string, agentId: string, threadId: string, owner: string, inputTokens: int,
              outputTokens: int, modelChoiceId: string, routeNote: string, agentName: string,
              promptVersion: int, modelApiName: string, question: string, answer: string,
              ok: bool, stopReason: string, rounds: int, fault: string, createdAt: string,
              steps: string) {
    this.id = id;
    this.agentId = agentId;
    this.threadId = threadId;
    this.owner = owner;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.modelChoiceId = modelChoiceId;
    this.routeNote = routeNote;
    this.agentName = agentName;
    this.promptVersion = promptVersion;
    this.modelApiName = modelApiName;
    this.question = question;
    this.answer = answer;
    this.ok = ok;
    this.stopReason = stopReason;
    this.rounds = rounds;
    this.error = fault;
    this.createdAt = createdAt;
    this.steps = steps;
  }
}

export function runRepository(): DbRepository {
  return entityRun;
}

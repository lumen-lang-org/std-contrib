import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("runs")
export class Run {
  @Id
  @Column("id", "text")
  id: string;

  @Column("agent_id", "text")
  agentId: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("owner", "text")
  owner: string;

  @Column("input_tokens", "int")
  inputTokens: int;

  @Column("output_tokens", "int")
  outputTokens: int;

  @Column("model_choice_id", "text")
  modelChoiceId: string;

  @Column("route_note", "text")
  routeNote: string;

  @Column("agent_name", "text")
  agentName: string;

  @Column("prompt_version", "int")
  promptVersion: int;

  @Column("model_api_name", "text")
  modelApiName: string;

  @Column("question", "text")
  question: string;

  @Column("answer", "text")
  answer: string;

  @Column("ok", "bool")
  ok: bool;

  @Column("stop_reason", "text")
  stopReason: string;

  @Column("rounds", "int")
  rounds: int;

  @Column("error", "text")
  error: string;

  @Column("created_at", "text")
  createdAt: string;

  @HasMany("run_steps", "id", "run_id",
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

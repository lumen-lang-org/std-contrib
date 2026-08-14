import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("workflow_runs")
export class WorkflowRun {
  @Id
  @Column("id", "text")
  id: string;

  @Column("workflow_id", "text")
  workflowId: string;

  @Column("owner", "text")
  owner: string;

  @Column("status", "text")
  status: string;

  @Column("input", "text")
  input: string;

  @Column("answer", "text")
  answer: string;

  @Column("error", "text")
  error: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("steps", "text")
  steps: string;

  @Column("started_at", "text")
  startedAt: string;

  @Column("ended_at", "text")
  endedAt: string;

  constructor(id: string, workflowId: string, owner: string, status: string, input: string,
              answer: string, fault: string, threadId: string, steps: string,
              startedAt: string, endedAt: string) {
    this.id = id;
    this.workflowId = workflowId;
    this.owner = owner;
    this.status = status;
    this.input = input;
    this.answer = answer;
    this.error = fault;
    this.threadId = threadId;
    this.steps = steps;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
  }
}

export function workflowRunRepository(): DbRepository {
  return entityWorkflowRun;
}

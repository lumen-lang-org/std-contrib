import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("scheduled_tasks")
export class ScheduledTask {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("agent_id", "text")
  agentId: string;

  @Column("model_choice_id", "text")
  modelChoiceId: string;

  @Column("title", "text")
  title: string;

  @Column("instruction", "text")
  instruction: string;

  @Column("kind", "text")
  kind: string;

  @Column("cron_expr", "text")
  cronExpr: string;

  @Column("tz", "text")
  tz: string;

  @Column("next_at", "text")
  nextAt: string;

  @Column("running_since", "text")
  runningSince: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("failures", "int")
  failures: int;

  @Column("paused_reason", "text")
  pausedReason: string;

  @Column("last_run_at", "text")
  lastRunAt: string;

  @Column("last_run_id", "text")
  lastRunId: string;

  @Column("last_status", "text")
  lastStatus: string;

  @Column("last_error", "text")
  lastError: string;

  @Column("run_count", "int")
  runCount: int;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, owner: string, agentId: string, modelChoiceId: string, title: string,
              instruction: string, kind: string, cronExpr: string, tz: string, nextAt: string,
              runningSince: string, enabled: bool, failures: int, pausedReason: string,
              lastRunAt: string, lastRunId: string, lastStatus: string, lastError: string,
              runCount: int, createdAt: string, updatedAt: string) {
    this.id = id;
    this.owner = owner;
    this.agentId = agentId;
    this.modelChoiceId = modelChoiceId;
    this.title = title;
    this.instruction = instruction;
    this.kind = kind;
    this.cronExpr = cronExpr;
    this.tz = tz;
    this.nextAt = nextAt;
    this.runningSince = runningSince;
    this.enabled = enabled;
    this.failures = failures;
    this.pausedReason = pausedReason;
    this.lastRunAt = lastRunAt;
    this.lastRunId = lastRunId;
    this.lastStatus = lastStatus;
    this.lastError = lastError;
    this.runCount = runCount;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export type ScheduledTaskRow = {
  id: string,
  owner: string,
  agentId: string,
  modelChoiceId: string,
  title: string,
  instruction: string,
  kind: string,
  cronExpr: string,
  tz: string,
  nextAt: string,
  runningSince: string,
  enabled: bool,
  failures: int,
  pausedReason: string,
  lastRunAt: string,
  lastRunId: string,
  lastStatus: string,
  lastError: string,
  runCount: int,
  createdAt: string,
  updatedAt: string,
};

export function scheduledTaskRepository(): DbRepository {
  return entityScheduledTask;
}

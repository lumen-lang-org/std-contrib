import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("trigger_bots")
export class TriggerBot {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("kind", "text")
  kind: string;

  @Column("name", "text")
  name: string;

  @Column("workflow_id", "text")
  workflowId: string;

  @Column("credential_ref", "text")
  credentialRef: string;

  @Column("cursor_offset", "text")
  offset: string;

  @Column("lease_by", "text")
  leaseBy: string;

  @Column("lease_until", "text")
  leaseUntil: string;

  @Column("enabled", "bool")
  enabled: bool;

  @Column("runs_today", "int")
  runsToday: int;

  @Column("day_started_at", "text")
  dayStartedAt: string;

  @Column("last_at", "text")
  lastAt: string;

  @Column("last_error", "text")
  lastError: string;

  @Column("draft_until", "text")
  draftUntil: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, owner: string, kind: string, name: string, workflowId: string,
              credentialRef: string, offset: string, leaseBy: string, leaseUntil: string,
              enabled: bool, runsToday: int, dayStartedAt: string, lastAt: string,
              lastError: string, draftUntil: string, createdAt: string, updatedAt: string) {
    this.id = id;
    this.owner = owner;
    this.kind = kind;
    this.name = name;
    this.workflowId = workflowId;
    this.credentialRef = credentialRef;
    this.offset = offset;
    this.leaseBy = leaseBy;
    this.leaseUntil = leaseUntil;
    this.enabled = enabled;
    this.runsToday = runsToday;
    this.dayStartedAt = dayStartedAt;
    this.lastAt = lastAt;
    this.lastError = lastError;
    this.draftUntil = draftUntil;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export function triggerBotRepository(): DbRepository {
  return entityTriggerBot;
}

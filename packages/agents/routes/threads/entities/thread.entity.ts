import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("threads")
export class Thread {
  @Id
  @Column("id", "text")
  id: string;

  @Column("agent_id", "text")
  agentId: string;

  @Column("owner", "text")
  owner: string;

  @Column("model_choice_id", "text")
  modelChoiceId: string;

  @Column("route_key", "text")
  routeKey: string;

  @Column("title", "text")
  title: string;

  @Column("replayable", "bool")
  replayable: bool;

  @Column("project_id", "text")
  projectId: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, agentId: string, owner: string, modelChoiceId: string, routeKey: string, title: string, replayable: bool, projectId: string, createdAt: string) {
    this.id = id;
    this.agentId = agentId;
    this.owner = owner;
    this.modelChoiceId = modelChoiceId;
    this.routeKey = routeKey;
    this.title = title;
    this.replayable = replayable;
    this.projectId = projectId;
    this.createdAt = createdAt;
  }
}

export function threadRepository(): DbRepository {
  return entityThread;
}

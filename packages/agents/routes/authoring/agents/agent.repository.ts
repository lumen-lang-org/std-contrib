import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, link, linkOf, listOrdered, pageOrdered, persist, placeholderAt, repository, setEvery, unlink, unlinkAllPointingAt, unlinkAllOwnedBy } from "../../../../plume/plume.ts";
import { AgentRetrievalRow, agentScopes, embeddingModel, grantScope, revokeScope } from "../../../knowledge.ts";
import { OWNED_AGENT, ownedRowsClause, ownerClause } from "../../../owner.ts";
import { agentRepository } from "./entities/agent.entity.ts";
import { agentRetrievalRepository } from "./entities/agent-retrieval.entity.ts";
import { mcpServerRepository } from "../../connectivity/servers/entities/mcp-server.entity.ts";
import { modelConfigRepository } from "../../inference/model-configs/entities/model-config.entity.ts";
import { modelRepository } from "../../inference/models/entities/model.entity.ts";
import { skillRepository } from "../skills/entities/skill.entity.ts";
import { runRepository } from "../../conversations/runs/entities/run.entity.ts";

// The runs table's own mapping, minus relations — the same shape
// runlog.ts's runsMapping() builds from the same entity, kept in step here
// rather than imported: runlog.ts also runs CRUD verbs of its own, and any
// import from it flags this whole file under repository-delegates-to-
// legacy-module.
function runsMapping(): DbRepository {
  return repository({
    table: "runs", idField: "id", idColumn: "id",
    fields: runRepository().fields,
  });
}

export class AgentRepository {
  database: Db;
  agents: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.agents = agentRepository();
  }

  listing(owner: string, enabledOnly: bool): string {
    let keys: DbOrder[] = [{ column: "agent_name" }];
    let mine = ownedRowsClause(this.database, OWNED_AGENT, 1);
    if (enabledOnly) {
      return listOrdered(this.database, this.agents, {
        where: mine + " AND enabled = " + placeholderAt(this.database, 2),
        args: [owner, "1"],
        order: keys,
      });
    }
    return listOrdered(this.database, this.agents, {
      where: mine, args: [owner], order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.agents, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.agents, id);
  }

  hasModelConfig(id: string): bool {
    return existsById(this.database, modelConfigRepository(), id);
  }

  hasPrompt(id: string): bool {
    return existsById(this.database, promptRepository(), id);
  }

  hasServer(id: string): bool {
    return existsById(this.database, mcpServerRepository(), id);
  }

  hasSkill(id: string): bool {
    return existsById(this.database, skillRepository(), id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.agents, document);
  }

  clearDefaults(): DbResult {
    return setEvery(this.database, this.agents, "is_default", "0");
  }

  linkServer(id: string, serverId: string): DbResult {
    return link(this.database, linkOf(this.agents, "servers"), { local: id, foreign: serverId });
  }

  unlinkServer(id: string, serverId: string): DbResult {
    return unlink(this.database, linkOf(this.agents, "servers"), { local: id, foreign: serverId });
  }

  linkChild(id: string, childId: string): DbResult {
    return link(this.database, linkOf(this.agents, "subAgents"), { local: id, foreign: childId });
  }

  unlinkChild(id: string, childId: string): DbResult {
    return unlink(this.database, linkOf(this.agents, "subAgents"), { local: id, foreign: childId });
  }

  linkSkill(id: string, skillId: string): DbResult {
    return link(this.database, linkOf(this.agents, "skills"), { local: id, foreign: skillId });
  }

  unlinkSkill(id: string, skillId: string): DbResult {
    return unlink(this.database, linkOf(this.agents, "skills"), { local: id, foreign: skillId });
  }

  scopes(id: string): string[] {
    return agentScopes(this.database, id);
  }

  grant(id: string, scope: string): string {
    return grantScope(this.database, id, scope);
  }

  revoke(id: string, scope: string): string {
    return revokeScope(this.database, id, scope);
  }

  embeddingUsable(modelId: string): bool {
    return embeddingModel(this.database, modelId).id != "";
  }

  saveRetrieval(row: AgentRetrievalRow): DbResult {
    return persist(this.database, agentRetrievalRepository(), JSON.stringify(row));
  }

  retrieval(id: string): string {
    return findById(this.database, agentRetrievalRepository(), id);
  }

  model(id: string): string {
    return findById(this.database, modelRepository(), id);
  }

  runs(id: string, tags: string[], limit: int): string {
    let keys: DbOrder[] = [{ column: "created_at", direction: "desc" }];
    let where = "agent_id = " + placeholderAt(this.database, 1);
    let args: string[] = [id];
    let mine = ownerClause(this.database, tags, 2);
    if (mine != "") {
      where = where + " AND " + mine;
      let i: int = 0;
      while (i < tags.length) {
        args.push(tags[i]);
        i = i + 1;
      }
    }
    return pageOrdered(this.database, runsMapping(), {
      where: where,
      args: args,
      order: keys,
      limit: limit,
      offset: 0,
    });
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      unlinkAllOwnedBy(this.database, linkOf(this.agents, "subAgents"), id),
      unlinkAllPointingAt(this.database, linkOf(this.agents, "subAgents"), id),
      unlinkAllOwnedBy(this.database, linkOf(this.agents, "servers"), id),
      unlinkAllOwnedBy(this.database, linkOf(this.agents, "skills"), id),
      unlinkAllOwnedBy(this.database, linkOf(this.agents, "scopes"), id),
      deleteById(this.database, agentRetrievalRepository(), id),
      deleteById(this.database, agentRepository(), id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}

import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, link, linkOf, listOrdered, persist, setEvery, unlink, unlinkAllPointingAt, unlinkAllOwnedBy } from "../../../../plume/plume.ts";
import { AgentRetrievalRow, agentScopes, embeddingModel, grantScope, revokeScope } from "../../../knowledge.ts";
import { agentRepository } from "./entities/agent.entity.ts";
import { agentRetrievalRepository } from "./entities/agent-retrieval.entity.ts";
import { mcpServerRepository } from "../../connectivity/servers/entities/mcp-server.entity.ts";
import { modelConfigRepository } from "../../inference/model-configs/entities/model-config.entity.ts";
import { modelRepository } from "../../inference/models/entities/model.entity.ts";
import { skillRepository } from "../skills/entities/skill.entity.ts";
import { agentWebRagRepository } from "./entities/agent-web-rag.entity.ts";
import { AgentWebRagRow, webRagFor } from "../../../webrag.ts";
import { runsOf } from "../../../runlog.ts";

export class AgentRepository {
  database: Db;
  agents: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.agents = agentRepository();
  }

  listing(enabledOnly: bool): string {
    let keys: DbOrder[] = [{ column: "agent_name" }];
    if (enabledOnly) {
      return listOrdered(this.database, this.agents, {
        where: "enabled = " + this.database.placeholder,
        args: ["1"],
        order: keys,
      });
    }
    return listOrdered(this.database, this.agents, { order: keys });
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

  webRag(id: string): AgentWebRagRow {
    return webRagFor(this.database, id);
  }

  saveWebRag(row: AgentWebRagRow): DbResult {
    return persist(this.database, agentWebRagRepository(), JSON.stringify(row));
  }

  storedWebRag(id: string): string {
    return findById(this.database, agentWebRagRepository(), id);
  }

  model(id: string): string {
    return findById(this.database, modelRepository(), id);
  }

  runs(id: string, tags: string[], limit: int): string {
    return runsOf(this.database, id, tags, limit);
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

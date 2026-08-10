import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, link, linkOf, listOrdered, persist, setEvery, unlink, unlinkForeign, unlinkLocal } from "../../../plume/plume.ts";
import { AgentRetrievalRow, agentRetrievalMapping, agentScopes, embeddingModel, grantScope, revokeScope } from "../../knowledge.ts";
import { agentRepository } from "./entities/agent.entity.ts";
import { mcpServerRepository } from "../servers/entities/mcp-server.entity.ts";
import { modelConfigRepository } from "../model-configs/entities/model-config.entity.ts";
import { modelRepository } from "../models/entities/model.entity.ts";
import { skillRepository } from "../skills/entities/skill.entity.ts";
import { AgentWebRagRow, agentWebRagMapping, webRagFor } from "../../webrag.ts";
import { runsOf } from "../../runlog.ts";

export class AgentRepository {
  db: Db;
  agents: DbRepository;

  constructor(db: Db) {
    this.db = db;
    this.agents = agentRepository();
  }

  listing(enabledOnly: bool): string {
    let keys: DbOrder[] = [{ column: "agent_name" }];
    if (enabledOnly) {
      return listOrdered(this.db, this.agents, {
        where: "enabled = " + this.db.placeholder,
        args: ["1"],
        order: keys,
      });
    }
    return listOrdered(this.db, this.agents, { order: keys });
  }

  one(id: string): string {
    return findById(this.db, this.agents, id);
  }

  exists(id: string): bool {
    return existsById(this.db, this.agents, id);
  }

  hasModelConfig(id: string): bool {
    return existsById(this.db, modelConfigRepository(), id);
  }

  hasPrompt(id: string): bool {
    return existsById(this.db, promptRepository(), id);
  }

  hasServer(id: string): bool {
    return existsById(this.db, mcpServerRepository(), id);
  }

  hasSkill(id: string): bool {
    return existsById(this.db, skillRepository(), id);
  }

  save(document: string): DbResult {
    return persist(this.db, this.agents, document);
  }

  clearDefaults(): DbResult {
    return setEvery(this.db, this.agents, "is_default", "0");
  }

  linkServer(id: string, serverId: string): DbResult {
    return link(this.db, linkOf(this.agents, "servers"), { local: id, foreign: serverId });
  }

  unlinkServer(id: string, serverId: string): DbResult {
    return unlink(this.db, linkOf(this.agents, "servers"), { local: id, foreign: serverId });
  }

  linkChild(id: string, childId: string): DbResult {
    return link(this.db, linkOf(this.agents, "subAgents"), { local: id, foreign: childId });
  }

  unlinkChild(id: string, childId: string): DbResult {
    return unlink(this.db, linkOf(this.agents, "subAgents"), { local: id, foreign: childId });
  }

  linkSkill(id: string, skillId: string): DbResult {
    return link(this.db, linkOf(this.agents, "skills"), { local: id, foreign: skillId });
  }

  unlinkSkill(id: string, skillId: string): DbResult {
    return unlink(this.db, linkOf(this.agents, "skills"), { local: id, foreign: skillId });
  }

  scopes(id: string): string[] {
    return agentScopes(this.db, id);
  }

  grant(id: string, scope: string): string {
    return grantScope(this.db, id, scope);
  }

  revoke(id: string, scope: string): string {
    return revokeScope(this.db, id, scope);
  }

  embeddingUsable(modelId: string): bool {
    return embeddingModel(this.db, modelId).id != "";
  }

  saveRetrieval(row: AgentRetrievalRow): DbResult {
    return persist(this.db, agentRetrievalMapping(), JSON.stringify(row));
  }

  retrieval(id: string): string {
    return findById(this.db, agentRetrievalMapping(), id);
  }

  webRag(id: string): AgentWebRagRow {
    return webRagFor(this.db, id);
  }

  saveWebRag(row: AgentWebRagRow): DbResult {
    return persist(this.db, agentWebRagMapping(), JSON.stringify(row));
  }

  storedWebRag(id: string): string {
    return findById(this.db, agentWebRagMapping(), id);
  }

  model(id: string): string {
    return findById(this.db, modelRepository(), id);
  }

  runs(id: string, tags: string[], limit: int): string {
    return runsOf(this.db, id, tags, limit);
  }

  forget(id: string): void {
    unlinkLocal(this.db, linkOf(this.agents, "subAgents"), id);
    unlinkForeign(this.db, linkOf(this.agents, "subAgents"), id);
    unlinkLocal(this.db, linkOf(this.agents, "servers"), id);
    unlinkLocal(this.db, linkOf(this.agents, "skills"), id);
    unlinkLocal(this.db, linkOf(this.agents, "scopes"), id);
    deleteById(this.db, agentRetrievalMapping(), id);
    deleteById(this.db, agentRepository(), id);
  }
}

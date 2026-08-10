import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, link, listOrdered, persist, setEvery, unlink, unlinkForeign, unlinkLocal } from "../../../plume/plume.ts";
import { AgentRetrievalRow, agentRetrievalMapping, agentScopes, embeddingModel, grantScope, revokeScope } from "../../knowledge.ts";
import { agentScopesLink, agentServersLink, agentSkillsLink, agentSubAgentsLink, agentsFull, agentsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping, promptsMapping, skillsMapping } from "../../schema.ts";
import { AgentWebRagRow, agentWebRagMapping, webRagFor } from "../../webrag.ts";
import { runsOf } from "../../runlog.ts";

// Rows in, rows out. Nothing here decides anything — no refusal sentences, no
// HTTP — and nothing here is written in SQL: the link tables are described once
// in schema.ts and both read and written through that description.
export class AgentRepository {
  db: Db;
  flat: DbRepository;
  full: DbRepository;

  constructor(db: Db) {
    this.db = db;
    this.flat = agentsMapping();
    this.full = agentsFull(db);
  }

  listing(enabledOnly: bool): string {
    let keys: DbOrder[] = [{ column: "agent_name" }];
    if (enabledOnly) {
      return listOrdered(this.db, this.full, { where: "enabled = " + this.db.placeholder, args: ["1"], order: keys });
    }
    return listOrdered(this.db, this.full, { order: keys });
  }

  one(id: string): string {
    return findById(this.db, this.full, id);
  }

  exists(id: string): bool {
    return existsById(this.db, this.flat, id);
  }

  hasModelConfig(id: string): bool {
    return existsById(this.db, modelConfigsMapping(this.db), id);
  }

  hasPrompt(id: string): bool {
    return existsById(this.db, promptsMapping(), id);
  }

  hasServer(id: string): bool {
    return existsById(this.db, mcpServersMapping(), id);
  }

  hasSkill(id: string): bool {
    return existsById(this.db, skillsMapping(), id);
  }

  save(document: string): DbResult {
    return persist(this.db, this.flat, document);
  }

  // Only one agent is the default, so claiming it takes it from whoever held it.
  clearDefaults(): DbResult {
    return setEvery(this.db, this.flat, "is_default", "0");
  }

  linkServer(id: string, serverId: string): DbResult {
    return link(this.db, agentServersLink(this.db), { local: id, foreign: serverId });
  }

  unlinkServer(id: string, serverId: string): DbResult {
    return unlink(this.db, agentServersLink(this.db), { local: id, foreign: serverId });
  }

  linkChild(id: string, childId: string): DbResult {
    return link(this.db, agentSubAgentsLink(this.db), { local: id, foreign: childId });
  }

  unlinkChild(id: string, childId: string): DbResult {
    return unlink(this.db, agentSubAgentsLink(this.db), { local: id, foreign: childId });
  }

  linkSkill(id: string, skillId: string): DbResult {
    return link(this.db, agentSkillsLink(), { local: id, foreign: skillId });
  }

  unlinkSkill(id: string, skillId: string): DbResult {
    return unlink(this.db, agentSkillsLink(), { local: id, foreign: skillId });
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
    return findById(this.db, modelsMapping(), id);
  }

  runs(id: string, tags: string[], limit: int): string {
    return runsOf(this.db, id, tags, limit);
  }

  // An agent is an aggregate: the row, and everything pointing at it. Nothing
  // here declares ON DELETE CASCADE, so deleting the row alone would leave link
  // rows behind for agentsFull's joins to surface as junk. Sub-agents point both
  // ways — this agent's children, and whoever claimed it as a child.
  forget(id: string): void {
    unlinkLocal(this.db, agentSubAgentsLink(this.db), id);
    unlinkForeign(this.db, agentSubAgentsLink(this.db), id);
    unlinkLocal(this.db, agentServersLink(this.db), id);
    unlinkLocal(this.db, agentSkillsLink(), id);
    unlinkLocal(this.db, agentScopesLink(), id);
    deleteById(this.db, agentRetrievalMapping(), id);
    deleteById(this.db, agentsMapping(), id);
  }
}

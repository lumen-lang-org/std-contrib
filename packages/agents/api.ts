// The agents API: the schema, served.
//
//   cd packages/agents && lumen run api.ts
//   curl -s localhost:8100/agents
//   curl -s localhost:8100/agents/a1
//   curl -s -X POST localhost:8100/agents -d '{"id":"a3",...}'
//   curl -s -X PUT  localhost:8100/agents/a1/model -d '{"modelConfigId":"c2"}'
//   curl -s -X PUT  localhost:8100/agents/a1/prompt -d '{"promptId":"p1"}'
//
// Every read goes to the database. Nothing is cached and nothing is compiled
// in, so a change made through this API — or by anything else touching the
// same tables — is visible to the very next request, with no restart. That is
// the whole requirement, and it is met by not doing the thing that would break
// it rather than by machinery.

import { controller } from "../rest/controller.ts";
import { Route } from "../rest/router.ts";
import { Request, Reply, Handler, serve, ok, created, noContent, notFound, badRequest, param, queryParam } from "../rest/server.ts";
import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { DbOrder, DbRepository, asc, placeholderAt, connectDatabase, persist, findById, listOrdered, existsById, deleteById, execute, executeWith, countWhere } from "../plume/plume.ts";
import { migrate } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, schemaPlan } from "./schema.ts";

// A change to which model or prompt an agent uses, as a body.
type ModelChange = { modelConfigId: string };
type PromptChange = { promptId: string };
type ServerLink = { serverId: string };

@controller("/agents")
class AgentApi {
  db: Db;
  flat: DbRepository;
  full: DbRepository;

  constructor(db: Db) {
    this.db = db;
    this.flat = agentsMapping();
    this.full = agentsFull(db);
  }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("agent_name")];
    if (queryParam(req, "enabled", "") == "true") {
      return ok(listOrdered(this.db, this.full, "enabled = " + this.db.placeholder, ["1"], keys));
    }
    return ok(listOrdered(this.db, this.full, "", [], keys));
  }

  // The whole agent: its prompt, its model config, its servers, its children.
  // One query, so a caller never has to assemble it.
  @get("/:id")
  find(req: Request): Reply {
    let document = findById(this.db, this.full, param(req, "id"));
    if (document == "") { return notFound("agent " + param(req, "id")); }
    return ok(document);
  }

  @post("/")
  create(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let written = persist(this.db, this.flat, req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, this.full, jsonId(req.body)));
  }

  // Moving an agent to a different model is an update to one column, which is
  // the point of keeping the model name in a row.
  @put("/:id/model")
  setModel(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let change: ModelChange = JSON.parse<ModelChange>(req.body);
    if (!existsById(this.db, modelConfigsMapping(this.db), change.modelConfigId)) {
      return badRequest("no model config " + change.modelConfigId);
    }
    executeWith(this.db, "UPDATE agents SET model_config_id = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [change.modelConfigId, param(req, "id")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  // Rolling a prompt back is pointing at an earlier version, which is why a
  // prompt row is never edited.
  @put("/:id/prompt")
  setPrompt(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let change: PromptChange = JSON.parse<PromptChange>(req.body);
    if (!existsById(this.db, promptsMapping(), change.promptId)) {
      return badRequest("no prompt " + change.promptId);
    }
    executeWith(this.db, "UPDATE agents SET prompt_id = " + this.db.placeholder
      + " WHERE id = " + placeholderAt(this.db, 2), [change.promptId, param(req, "id")]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  @post("/:id/servers")
  addServer(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    let link: ServerLink = JSON.parse<ServerLink>(req.body);
    if (!existsById(this.db, mcpServersMapping(), link.serverId)) {
      return badRequest("no server " + link.serverId);
    }
    executeWith(this.db, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ("
      + this.db.placeholder + ", " + placeholderAt(this.db, 2) + ")", [param(req, "id"), link.serverId]);
    return ok(findById(this.db, this.full, param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, this.flat, param(req, "id"))) {
      return notFound("agent " + param(req, "id"));
    }
    executeWith(this.db, "DELETE FROM agent_sub_agents WHERE parent_id = " + this.db.placeholder, [param(req, "id")]);
    executeWith(this.db, "DELETE FROM agent_mcp_servers WHERE agent_id = " + this.db.placeholder, [param(req, "id")]);
    deleteById(this.db, this.flat, param(req, "id"));
    return noContent();
  }
}

// An id read out of a posted document, so a create can answer with the whole
// agent rather than the fragment it was given.
function jsonId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) { return ""; }
  let rest = document.substring(at + 4, document.length);
  let open = rest.indexOf("\"");
  if (open < 0) { return ""; }
  let value = rest.substring(open + 1, rest.length);
  return value.substring(0, value.indexOf("\""));
}


function openDatabase(): Db {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_api.db" };
  connectDatabase(db, cfg);
  migrate(db, schemaPlan(db));
  return db;
}

function seed(db: Db): void {
  if (countWhere(db, agentsMapping(), "", []) > 0) { return; }
  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", enabled: true };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(opus));
  persist(db, modelsMapping(), JSON.stringify(haiku));
  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}" };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}" };
  persist(db, modelConfigsMapping(this.db), JSON.stringify(careful));
  persist(db, modelConfigsMapping(this.db), JSON.stringify(quick));
  let p1: PromptRow = { id: "p1", promptName: "lead", version: 1, body: "You lead.", createdAt: "2026-07-25" };
  let p2: PromptRow = { id: "p2", promptName: "lead", version: 2, body: "You lead, briefly.", createdAt: "2026-07-25" };
  persist(db, promptsMapping(), JSON.stringify(p1));
  persist(db, promptsMapping(), JSON.stringify(p2));
  let fsSrv: McpServerRow = { id: "s1", serverName: "filesystem", transport: "stdio", endpoint: "mcp-fs", enabled: true };
  let ghSrv: McpServerRow = { id: "s2", serverName: "github", transport: "http", endpoint: "https://mcp.gh", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(db, mcpServersMapping(), JSON.stringify(ghSrv));
  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p1", enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(scout));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a1','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
}

function main(): void {
  let db = openDatabase();
  seed(db);
  let api = new AgentApi(db);

  let bound = new Map<string, Handler>();
  bound.set("list", (req: Request) => { return api.list(req); });
  bound.set("find", (req: Request) => { return api.find(req); });
  bound.set("create", (req: Request) => { return api.create(req); });
  bound.set("setModel", (req: Request) => { return api.setModel(req); });
  bound.set("setPrompt", (req: Request) => { return api.setPrompt(req); });
  bound.set("addServer", (req: Request) => { return api.addServer(req); });
  bound.set("remove", (req: Request) => { return api.remove(req); });

  let i: int = 0;
  while (i < controllerAgentApi.length) {
    console.log("route  " + controllerAgentApi[i].method + " " + controllerAgentApi[i].pattern
      + " -> " + controllerAgentApi[i].handler);
    i = i + 1;
  }

  let problem = serve(8100, controllerAgentApi, bound);
  if (problem != "") { console.error(problem); }
}

main();

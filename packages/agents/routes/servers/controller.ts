import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson, param } from "../../../rest/server.ts";
import { callerTags, stamp } from "../../api-core.ts";
import { accessTokenFor, connectionOf, forgetConnector, setToolOn, suppliedClientId, toolsOff, userTokenKey } from "../../connect.ts";
import { DestinationMove, destinationProblem, forgetCredential, hasCredential, storeCredential } from "../../credentials.ts";
import { forgetRoster, rememberRoster, rosterOf, rosterWithSwitches } from "../../mcp-roster.ts";
import { toolListing } from "../../mcp.ts";
import { owningTag } from "../../owner.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { McpServerRow, mcpServersMapping } from "../../schema.ts";
import { ConnectionView, MineAsk, ServerAuth, ServerToolsView, StoredView, ToolSwitch, ToolView } from "./types.ts";

export function serverDestinationProblem(db: Db, row: McpServerRow): string {
  let held = findById(db, mcpServersMapping(), row.id);
  let was = "";
  if (held != "") { was = JSON.parse<McpServerRow>(held).endpoint; }
  let move: DestinationMove = {
    subject: "server " + row.id,
    secretName: "its token",
    clearWith: "PUT /servers/" + row.id + "/auth with {\"authKind\":\"none\",\"authHeader\":\"\",\"token\":\"\"}",
    was: was,
    now: row.endpoint,
    secretStored: hasCredential(db, "mcp:" + row.id),
  };
  return destinationProblem(move);
}

export function forgetServer(db: Db, serverId: string): void {
  executeWith(db, "DELETE FROM agent_mcp_servers WHERE server_id = " + db.placeholder, [serverId]);
  deleteById(db, mcpServersMapping(), serverId);
  forgetCredential(db, "mcp:" + serverId);
}

@controller("/servers")
export class ServerApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("server_name")];
    return ok(listOrdered(this.db, mcpServersMapping(), "", [], keys));
  }

  @get("/:id/tools")
  tools(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("no server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let listed = toolListing(server, accessTokenFor(this.db, server, owningTag(callerTags(req)), this.master));
    let declined = toolsOff(this.db, server.id);

    if (listed.problem == "") {
      rememberRoster(this.db, server.id, listed.tools, `${Date.now()}`);
    } else {
      let held = rosterOf(this.db, server.id);
      if (held.listedAt != "") {
        return ok("{\"serverId\":" + JSON.stringify(server.id)
          + ",\"problem\":" + JSON.stringify(listed.problem)
          + ",\"stale\":true,\"listedAt\":" + JSON.stringify(held.listedAt)
          + ",\"tools\":" + rosterWithSwitches(held.tools, declined) + "}");
      }
    }

    let views: ToolView[] = [];
    let i: int = 0;
    while (i < listed.tools.length) {
      let one: ToolView = {
        name: listed.tools[i].name,
        description: listed.tools[i].description,
        on: !declined.includes(listed.tools[i].name),
      };
      views.push(one);
      i = i + 1;
    }
    let v: ServerToolsView = {
      serverId: server.id,
      problem: listed.problem,
      stale: false,
      listedAt: "",
      tools: views,
    };
    return okJson(v);
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, mcpServersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let body: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (body.transport != "http") {
      return badRequest("this speaks http; \"" + body.transport + "\" needs a subprocess it cannot spawn");
    }
    let moved = serverDestinationProblem(this.db, body);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, mcpServersMapping(), jsonId(req.body)));
  }

  @put("/:id/auth")
  setAuth(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: ServerAuth = JSON.parse<ServerAuth>(req.body);
    if (body.authKind != "none" && body.authKind != "bearer"
        && body.authKind != "header" && body.authKind != "oauth") {
      return badRequest("auth is none, bearer, header or oauth, not \"" + body.authKind + "\"");
    }
    if (body.authKind == "header" && body.authHeader.trim() == "") {
      return badRequest("a custom header needs a name");
    }
    if (body.authKind != "none" && body.authKind != "oauth" && body.token == "") {
      return badRequest("that auth kind needs a token");
    }
    if (body.authKind == "oauth" && body.token != "") {
      return badRequest("an OAuth connector is signed in to, not given a token — press Connect");
    }
    executeWith(this.db, "UPDATE mcp_servers SET auth_kind = " + this.db.placeholder
      + ", auth_header = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [body.authKind, body.authHeader, param(req, "id")]);
    if (body.authKind == "none") {
      forgetConnector(this.db, param(req, "id"), this.master);
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    if (body.authKind == "oauth") {
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    let stored = storeCredential(this.db, { provider: "mcp:" + param(req, "id"),
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  @put("/:id/tools/:tool")
  setTool(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: ToolSwitch = JSON.parse<ToolSwitch>(req.body);
    if (param(req, "tool").trim() == "") { return badRequest("a tool needs a name"); }
    setToolOn(this.db, param(req, "id"), param(req, "tool"), body.on);
    return noContent();
  }

  @put("/:id/mine")
  setMine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      return badRequest("a personal token needs a signed-in person — this deployment saw nobody");
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let asked: MineAsk = JSON.parse<MineAsk>(req.body);
    if (asked.token == "") {
      return badRequest("a token is required — to stop using your own, DELETE this route instead");
    }
    let stored = storeCredential(this.db, { provider: userTokenKey(param(req, "id"), owner),
      apiKey: asked.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    let v: StoredView = { stored: true };
    return okJson(v);
  }

  @get("/:id/mine")
  mine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      let none: StoredView = { stored: false };
      return okJson(none);
    }
    let has = hasCredential(this.db, userTokenKey(param(req, "id"), owner));
    let v: StoredView = { stored: has };
    return okJson(v);
  }

  @del("/:id/mine")
  forgetMine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") { return badRequest("nobody is signed in, so there is nothing of theirs to forget"); }
    forgetCredential(this.db, userTokenKey(param(req, "id"), owner));
    return noContent();
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    if (row.serverName.trim() == "") { return badRequest("a server needs a name"); }
    if (row.transport != "http") {
      return badRequest("this speaks http; \"" + row.transport + "\" needs a subprocess it cannot spawn");
    }
    if (row.endpoint.trim() == "") { return badRequest("a server needs an endpoint"); }
    let moved = serverDestinationProblem(this.db, row);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    forgetServer(this.db, param(req, "id"));
    forgetConnector(this.db, param(req, "id"), this.master);
    forgetRoster(this.db, param(req, "id"));
    return noContent();
  }

  @get("/connections")
  connections(req: Request): Reply {
    let owner = owningTag(callerTags(req));
    let keys: DbOrder[] = [asc("server_name")];
    let rows = JSON.parse<McpServerRow[]>(listOrdered(this.db, mcpServersMapping(), "", [], keys));
    let views: ConnectionView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let held = connectionOf(this.db, rows[i].id, owner);
      let one: ConnectionView = {
        serverId: rows[i].id,
        authKind: rows[i].authKind,
        state: held.state,
        whose: held.whose,
        clientId: suppliedClientId(this.db, rows[i].id, this.master),
        connectedAt: held.connectedAt,
      };
      views.push(one);
      i = i + 1;
    }
    return okJson(views);
  }
}

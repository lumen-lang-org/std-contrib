import { Db } from "../../../plume/driver.ts";
import { DbOrder, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Created, NoContent, NotFound, Ok, OkJson } from "../../../rest/server.ts";
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
  if (held != "") {
    was = JSON.parse<McpServerRow>(held).endpoint;
  }
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
@bindings
export class ServerApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [{ column: "server_name" }];
    return Ok(listOrdered(this.db, mcpServersMapping(), { order: keys }));
  }

  @Get("/:id/tools")
  tools(req: Request, @PathVariable("id") id: string): Reply {
    let document = findById(this.db, mcpServersMapping(), id);
    if (document == "") {
      return NotFound("no server " + id);
    }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let listed = toolListing(server, accessTokenFor(this.db, server, owningTag(callerTags(req)), this.master));
    let declined = toolsOff(this.db, server.id);

    if (listed.problem == "") {
      rememberRoster(this.db, server.id, listed.tools, `${Date.now()}`);
    } else {
      let held = rosterOf(this.db, server.id);
      if (held.listedAt != "") {
        return Ok("{\"serverId\":" + JSON.stringify(server.id)
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
    return OkJson(v);
  }

  @Post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, mcpServersMapping(), req.body);
    if (problem != "") {
      return BadRequest(problem);
    }
    let body: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (body.transport != "http") {
      return BadRequest("this speaks http; \"" + body.transport + "\" needs a subprocess it cannot spawn");
    }
    let moved = serverDestinationProblem(this.db, body);
    if (moved != "") {
      return BadRequest(moved);
    }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, mcpServersMapping(), jsonId(req.body)));
  }

  @Put("/:id/auth")
  setAuth(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let body: ServerAuth = JSON.parse<ServerAuth>(req.body);
    if (body.authKind != "none" && body.authKind != "bearer"
        && body.authKind != "header" && body.authKind != "oauth") {
      return BadRequest("auth is none, bearer, header or oauth, not \"" + body.authKind + "\"");
    }
    if (body.authKind == "header" && body.authHeader.trim() == "") {
      return BadRequest("a custom header needs a name");
    }
    if (body.authKind != "none" && body.authKind != "oauth" && body.token == "") {
      return BadRequest("that auth kind needs a token");
    }
    if (body.authKind == "oauth" && body.token != "") {
      return BadRequest("an OAuth connector is signed in to, not given a token — press Connect");
    }
    executeWith(this.db, "UPDATE mcp_servers SET auth_kind = " + this.db.placeholder
      + ", auth_header = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [body.authKind, body.authHeader, id]);
    if (body.authKind == "none") {
      forgetConnector(this.db, id, this.master);
      return Ok(findById(this.db, mcpServersMapping(), id));
    }
    if (body.authKind == "oauth") {
      return Ok(findById(this.db, mcpServersMapping(), id));
    }
    let stored = storeCredential(this.db, { provider: "mcp:" + id,
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return BadRequest(stored);
    }
    return Ok(findById(this.db, mcpServersMapping(), id));
  }

  @Put("/:id/tools/:tool")
  setTool(req: Request, @PathVariable("id") id: string, @PathVariable("tool") tool: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let body: ToolSwitch = JSON.parse<ToolSwitch>(req.body);
    if (tool.trim() == "") {
      return BadRequest("a tool needs a name");
    }
    setToolOn(this.db, id, tool, body.on);
    return NoContent();
  }

  @Put("/:id/mine")
  setMine(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      return BadRequest("a personal token needs a signed-in person — this deployment saw nobody");
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let asked: MineAsk = JSON.parse<MineAsk>(req.body);
    if (asked.token == "") {
      return BadRequest("a token is required — to stop using your own, DELETE this route instead");
    }
    let stored = storeCredential(this.db, { provider: userTokenKey(id, owner),
      apiKey: asked.token, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return BadRequest(stored);
    }
    let v: StoredView = { stored: true };
    return OkJson(v);
  }

  @Get("/:id/mine")
  mine(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      let none: StoredView = { stored: false };
      return OkJson(none);
    }
    let has = hasCredential(this.db, userTokenKey(id, owner));
    let v: StoredView = { stored: has };
    return OkJson(v);
  }

  @Delete("/:id/mine")
  forgetMine(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") {
      return BadRequest("nobody is signed in, so there is nothing of theirs to forget");
    }
    forgetCredential(this.db, userTokenKey(id, owner));
    return NoContent();
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let row: McpServerRow = JSON.parse<McpServerRow>(req.body);
    if (row.id != id) {
      return BadRequest("the id in the body must match the path");
    }
    if (row.serverName.trim() == "") {
      return BadRequest("a server needs a name");
    }
    if (row.transport != "http") {
      return BadRequest("this speaks http; \"" + row.transport + "\" needs a subprocess it cannot spawn");
    }
    if (row.endpoint.trim() == "") {
      return BadRequest("a server needs an endpoint");
    }
    let moved = serverDestinationProblem(this.db, row);
    if (moved != "") {
      return BadRequest(moved);
    }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, mcpServersMapping(), id));
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    forgetServer(this.db, id);
    forgetConnector(this.db, id, this.master);
    forgetRoster(this.db, id);
    return NoContent();
  }

  @Get("/connections")
  connections(req: Request): Reply {
    let owner = owningTag(callerTags(req));
    let keys: DbOrder[] = [{ column: "server_name" }];
    let rows = JSON.parse<McpServerRow[]>(listOrdered(this.db, mcpServersMapping(), { order: keys }));
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
    return OkJson(views);
  }
}

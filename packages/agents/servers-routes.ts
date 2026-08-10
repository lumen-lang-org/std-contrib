// The /servers routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { callerTags, stamp } from "./api-core.ts";
import { accessTokenFor, connectionOf, forgetConnector, setToolOn, suppliedClientId, toolsOff, userTokenKey } from "./connect.ts";
import { DestinationMove, destinationProblem, forgetCredential, hasCredential, masterKey, storeCredential } from "./credentials.ts";
import { forgetRoster, rememberRoster, rosterOf, rosterWithSwitches } from "./mcp-roster.ts";
import { toolListing } from "./mcp.ts";
import { owningTag } from "./owner.ts";
import { createProblem, jsonId } from "./payload.ts";
import { McpServerRow, mcpServersMapping } from "./schema.ts";

type ServerAuth = { authKind: string, authHeader: string, token: string };

// The one member PUT /servers/:id/tools/:tool reads.
type ToolSwitch = { on: bool };

// The one member PUT /servers/:id/mine reads.
type MineAsk = {
  token: string,
};

// Whether this server row may be written, given the token stored under its id.
//
// The token lives under "mcp:" + id and is not re-keyed when the endpoint
// moves, so `PUT /servers/:id` followed by a plain `GET /servers/:id/tools`
// delivers the bearer token to whatever address was just written. A server
// with no row yet has no address on record, so any endpoint is a move — which
// is what catches a recycled id whose predecessor's token is still stored.
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

// Delete a server, its token and its links.
//
// The token went unnoticed: `remove` deleted the row and the agent links and
// left `mcp:<id>` in the credential store. Ids come out of the request body
// and are short human strings, so recycling "s1" is ordinary — and the next
// run sent the old server's secret to the new server's endpoint.
export function forgetServer(db: Db, serverId: string): void {
  executeWith(db, "DELETE FROM agent_mcp_servers WHERE server_id = " + db.placeholder, [serverId]);
  deleteById(db, mcpServersMapping(), serverId);
  forgetCredential(db, "mcp:" + serverId);
}

@controller("/servers")
export class ServerApi {
  db: Db;
  // Setting a server's auth writes its token to the encrypted store.
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("server_name")];
    return ok(listOrdered(this.db, mcpServersMapping(), "", [], keys));
  }

  // What this server offers, asked of the server itself.
  //
  // Not stored: an MCP server's tool list is its own to change, and a copy
  // here would be a second source of truth that goes stale silently. The
  // console draws what the server says right now, or says why it could not
  // be asked — an unreachable server and one with no tools look the same on
  // a graph and mean opposite things.
  @get("/:id/tools")
  tools(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("no server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    // The caller's own token when they stored one — the listing should see the
    // same tools a run on their conversation will mount, through the same
    // resolver, so an OAuth connector is refreshed here too rather than
    // reporting "could not be asked" until somebody starts a conversation.
    let listed = toolListing(server, accessTokenFor(this.db, server, owningTag(callerTags(req)), this.master));
    let declined = toolsOff(this.db, server.id);

    // A listing that worked is kept, so the next caller who cannot get one —
    // not signed in, token stale, server down — still has real tool names to
    // choose from. Only on success: overwriting a good roster with an empty
    // one on a network blip is how a cache stops being worth having.
    if (listed.problem == "") {
      rememberRoster(this.db, server.id, listed.tools, `${Date.now()}`);
    } else {
      // Nothing live. Answer what it last said, dated, and keep the problem
      // in the reply — the screen shows both: the names, and why they are not
      // fresh. `listedAt` empty means it has never been listed at all, which
      // is the honest "there is nothing to show you yet".
      let held = rosterOf(this.db, server.id);
      if (held.listedAt != "") {
        return ok("{\"serverId\":" + JSON.stringify(server.id)
          + ",\"problem\":" + JSON.stringify(listed.problem)
          + ",\"stale\":true,\"listedAt\":" + JSON.stringify(held.listedAt)
          + ",\"tools\":" + rosterWithSwitches(held.tools, declined) + "}");
      }
    }

    let out = "{\"serverId\":" + JSON.stringify(server.id)
      + ",\"problem\":" + JSON.stringify(listed.problem)
      + ",\"stale\":false,\"listedAt\":\"\",\"tools\":[";
    let i: int = 0;
    while (i < listed.tools.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"name\":" + JSON.stringify(listed.tools[i].name)
        + ",\"description\":" + JSON.stringify(listed.tools[i].description)
        // Whether it is actually mounted. The listing is what the connector
        // offers; this is what this deployment does with it, and a screen that
        // showed only the first would offer switches it could not reflect.
        + ",\"on\":" + (declined.includes(listed.tools[i].name) ? "false" : "true") + "}";
      i = i + 1;
    }
    return ok(out + "]}");
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, mcpServersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let body: McpServerRow = JSON.parse<McpServerRow>(req.body);
    // The same rule the update path applies. Accepting "stdio" here and
    // refusing it there let a server be created that could never afterwards be
    // saved — including the one the seed shipped.
    if (body.transport != "http") {
      return badRequest("this speaks http; \"" + body.transport + "\" needs a subprocess it cannot spawn");
    }
    let moved = serverDestinationProblem(this.db, body);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, mcpServersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, mcpServersMapping(), jsonId(req.body)));
  }

  // How a server authenticates us. The token never lands in this table: it
  // goes through the same encrypted store as a provider key, under the
  // server's own id, because a secret beside the thing it authenticates is
  // decoration.
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
    // "oauth" is the one kind whose token cannot be typed: it is issued by the
    // connector to this person, through POST /connect/:id/start. Accepting one
    // here would be accepting a token nothing can refresh.
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
      // Switching a server to no auth used to leave the token in the store,
      // where nothing ever read it again and nothing ever deleted it — until
      // the kind was switched back, or the id was reused. Everybody's, not
      // just the deployment's: a per-person token for a connector that no
      // longer authenticates is a secret with nothing left to send it to.
      forgetConnector(this.db, param(req, "id"), this.master);
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    if (body.authKind == "oauth") {
      // Nothing to store yet — this only says HOW the connector signs in. The
      // tokens arrive when somebody presses Connect.
      return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
    }
    let stored = storeCredential(this.db, { provider: "mcp:" + param(req, "id"),
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok(findById(this.db, mcpServersMapping(), param(req, "id")));
  }

  /* Switch one of this connector's tools on or off.
   *
   * Deployment-wide rather than per-person, unlike the token: a tool being
   * mounted decides what every conversation's model is told it can do, and two
   * people on one deployment disagreeing about that would make the same agent
   * behave differently depending on who asked.
   *
   * It exists because tool specs are spent context. Linear offers 52, each
   * with a JSON Schema, and mounting all of them put more in the prompt than a
   * small local model could hold — it refused the request outright rather than
   * answering badly. Switching some off is what makes such a connector usable
   * at all on a model that is not enormous.
   */
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

  // The caller's OWN token for this server — the per-person half of auth.
  //
  // The deployment's token (PUT /:id/auth above) is one credential everybody
  // rides, which is right for a company Jira and wrong for a personal GitHub:
  // one account, one rate limit, one audit trail, shared by every user. This
  // pair of routes lets a signed-in person store a token that is theirs —
  // used for THEIR conversations, fallback to the shared one for everyone
  // else. Keyed by (server, owner) in the same encrypted store, and never
  // read back, exactly like every other credential here.
  //
  // No :owner in the path, ever: the owner is whoever the verified header
  // says is asking. A route that took the owner as a parameter would be a
  // route for writing other people's credentials.
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
    return ok("{\"stored\":true}");
  }

  // Whether the caller has one stored — true/false and nothing else, because
  // the token itself can never be read back.
  @get("/:id/mine")
  mine(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    let owner = owningTag(callerTags(req));
    if (owner == "") { return ok("{\"stored\":false}"); }
    let has = hasCredential(this.db, userTokenKey(param(req, "id"), owner));
    return ok("{\"stored\":" + (has ? "true" : "false") + "}");
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
    // Only the transport the client actually speaks. Offering one it refuses
    // is offering a server that mounts no tools and says why only at run time.
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
    // Every token anyone stored for it, and the registration behind them.
    forgetConnector(this.db, param(req, "id"), this.master);
    // And what it last said it could do — a roster outliving its server is a
    // list of tools nothing can call, and would be handed to the next server
    // that happened to reuse the id.
    forgetRoster(this.db, param(req, "id"));
    return noContent();
  }

  // (The tools listing lives at 2401 — another hand had already built
  // GET /:id/tools when this controller grew a second copy, and the router
  // refuses a route that can never match rather than letting it shadow.)

  // Whether each connector is connected, for whoever is asking.
  //
  // Its own route rather than a field on GET /servers because the answer is
  // per-caller: the same connector is "connected" for the person who signed in
  // to it and "not connected" for everybody else, and a listing that cached
  // would be wrong for one of them.
  @get("/connections")
  connections(req: Request): Reply {
    let owner = owningTag(callerTags(req));
    let keys: DbOrder[] = [asc("server_name")];
    let rows = JSON.parse<McpServerRow[]>(listOrdered(this.db, mcpServersMapping(), "", [], keys));
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      let held = connectionOf(this.db, rows[i].id, owner);
      out = out + "{\"serverId\":" + JSON.stringify(rows[i].id)
        + ",\"authKind\":" + JSON.stringify(rows[i].authKind)
        + ",\"state\":" + JSON.stringify(held.state)
        + ",\"whose\":" + JSON.stringify(held.whose)
        // Whether an operator gave this connector an OAuth client of its own,
        // so the console can say "an app is needed" before somebody presses a
        // button that cannot finish. The client id is not a secret — it rides
        // in the consent URL the browser visits — and the secret beside it is
        // answered by nothing.
        + ",\"clientId\":" + JSON.stringify(suppliedClientId(this.db, rows[i].id, this.master))
        + ",\"connectedAt\":" + JSON.stringify(held.connectedAt) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }
}

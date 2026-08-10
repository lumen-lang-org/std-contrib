// The /connect routes.

import { Db } from "../plume/driver.ts";
import { existsById, findById } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, ok, param, problem, reply } from "../rest/server.ts";
import { callerTags } from "./api-core.ts";
import { beginConnect, completeConnect, disconnect, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "./connect.ts";
import { owningTag } from "./owner.ts";
import { McpServerRow, mcpServersMapping } from "./schema.ts";

// The two halves of an OAuth client, as PUT /connect/:id/client is given them.
type SuppliedClientAsk = {
  clientId: string,
  clientSecret: string,
};

// The address a connector sends the browser back to, or "" when this
// deployment does not know its own public name.
//
// It has to be absolute and it has to match what was registered, so it cannot
// be derived from the request: behind the console's proxy and the gateway, the
// Host this process sees is an internal one. One variable, set once.
function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") { return ""; }
  while (origin.endsWith("/")) { origin = origin.slice(0, origin.length - 1); }
  return origin + "/api/connect/callback";
}

// The page the browser lands on after a consent screen.
//
// Deliberately plain and deliberately self-closing. A person who pressed
// Connect is looking at a popup over the console, and the useful outcome is
// that it goes away and the page behind it knows to refresh.
function connectPage(worked: bool, detail: string): Reply {
  let title = worked ? "Connected" : "Not connected";
  let line = worked
    ? "You can close this window."
    : jsonSafe(detail);
  let body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>"
    + title + "</title><style>"
    + "body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;"
    + "height:100vh;background:#fafafa;color:#17171a}"
    + "div{text-align:center;max-width:32rem;padding:0 1.5rem}"
    + "h1{font-size:17px;margin:0 0 .35rem}p{margin:0;color:#6b6b70}"
    + "</style></head><body><div><h1>" + title + (worked ? " to " + jsonSafe(detail) : "")
    + "</h1><p>" + line + "</p></div>"
    // The opener is told which way it went, so the console can reload the one
    // list that changed rather than everything. `postMessage` is targeted at
    // this deployment's own origin; a popup that shouted at "*" would tell any
    // page that happened to open it.
    + "<script>try{if(window.opener){window.opener.postMessage("
    + "{joule:\"connector\",ok:" + (worked ? "true" : "false") + "},window.location.origin)}}catch(e){}"
    + "setTimeout(function(){window.close()}," + (worked ? "900" : "4000") + ")</script>"
    + "</body></html>";
  return reply(200, body, "text/html; charset=utf-8");
}

@controller("/connect")
export class ConnectApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // Where the browser should go to approve this connector.
  @post("/:id/start")
  start(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let began = beginConnect(this.db, server, owningTag(callerTags(req)), this.master, callbackUri());
    if (began.problem != "") { return badRequest(began.problem); }
    return ok("{\"url\":" + JSON.stringify(began.url) + "}");
  }

  // Where the connector sends the browser back to.
  //
  // Answers HTML rather than JSON, uniquely in this file, because the reader
  // is a browser window a person is looking at and not a program. It closes
  // itself; the console notices through the opener and reloads.
  @get("/callback")
  callback(req: Request): Reply {
    let refused = req.query.get("error") ?? "";
    if (refused != "") {
      let said = req.query.get("error_description") ?? "";
      return connectPage(false, said == "" ? refused : said);
    }
    let done = completeConnect(this.db, this.master,
      req.query.get("state") ?? "", req.query.get("code") ?? "");
    if (done.problem != "") { return connectPage(false, done.problem); }
    return connectPage(true, done.serverName);
  }

  // Give this connector an OAuth client created by hand in the vendor's own
  // developer console.
  //
  // For the connectors that do not register clients automatically — Asana's v2
  // server, Slack, Box — which is most of the ones people actually ask for.
  // Deployment-wide and not per person, because the connector row it hangs off
  // is deployment-wide: the app belongs to whoever runs Joule, and each person
  // then signs in to it with their own account.
  //
  // Answered back is the client id only, and only because it is not a secret:
  // it travels in the consent URL every browser visits. The secret goes in and
  // never comes out, like every other credential here.
  @put("/:id/client")
  setClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    let ask: SuppliedClientAsk = JSON.parse<SuppliedClientAsk>(req.body);
    let refused = setSuppliedClient(this.db, id, ask.clientId, ask.clientSecret, this.master);
    if (refused != "") { return badRequest(refused); }
    return ok("{\"clientId\":" + JSON.stringify(suppliedClientId(this.db, id, this.master)) + "}");
  }

  // Take it away again. The connector goes back to registering itself, which
  // works where the vendor allows it and says so plainly where it does not.
  @del("/:id/client")
  dropClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    forgetSuppliedClient(this.db, id);
    return noContent();
  }

  // Hand a connection back. The caller's own, never anybody else's — the owner
  // is read from the verified header, exactly as DELETE /servers/:id/mine is.
  @del("/:id")
  drop(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    disconnect(this.db, param(req, "id"), owningTag(callerTags(req)));
    return noContent();
  }
}

import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, ok, param, problem, reply } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { beginConnect, completeConnect, disconnect, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "../../connect.ts";
import { owningTag } from "../../owner.ts";
import { McpServerRow, mcpServersMapping } from "../../schema.ts";
import { SuppliedClientAsk } from "./types.ts";

function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") { return ""; }
  while (origin.endsWith("/")) { origin = origin.slice(0, origin.length - 1); }
  return origin + "/api/connect/callback";
}

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

  @post("/:id/start")
  start(req: Request): Reply {
    let document = findById(this.db, mcpServersMapping(), param(req, "id"));
    if (document == "") { return notFound("server " + param(req, "id")); }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let began = beginConnect(this.db, server, owningTag(callerTags(req)), this.master, callbackUri());
    if (began.problem != "") { return badRequest(began.problem); }
    return ok("{\"url\":" + JSON.stringify(began.url) + "}");
  }

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

  @put("/:id/client")
  setClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    let ask: SuppliedClientAsk = JSON.parse<SuppliedClientAsk>(req.body);
    let refused = setSuppliedClient(this.db, id, ask.clientId, ask.clientSecret, this.master);
    if (refused != "") { return badRequest(refused); }
    return ok("{\"clientId\":" + JSON.stringify(suppliedClientId(this.db, id, this.master)) + "}");
  }

  @del("/:id/client")
  dropClient(req: Request): Reply {
    let id = param(req, "id");
    if (!existsById(this.db, mcpServersMapping(), id)) { return notFound("server " + id); }
    forgetSuppliedClient(this.db, id);
    return noContent();
  }

  @del("/:id")
  drop(req: Request): Reply {
    if (!existsById(this.db, mcpServersMapping(), param(req, "id"))) {
      return notFound("server " + param(req, "id"));
    }
    disconnect(this.db, param(req, "id"), owningTag(callerTags(req)));
    return noContent();
  }
}

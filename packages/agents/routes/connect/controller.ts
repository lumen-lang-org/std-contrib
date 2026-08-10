import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, okJson, param, problem, reply } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { beginConnect, completeConnect, disconnect, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "../../connect.ts";
import { owningTag } from "../../owner.ts";
import { McpServerRow, mcpServersMapping } from "../../schema.ts";
import { ConnectStarted, SuppliedClientAsk, SuppliedClientView } from "./types.ts";
import { connectPageHtml } from "./page.ts";

function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") { return ""; }
  while (origin.endsWith("/")) { origin = origin.slice(0, origin.length - 1); }
  return origin + "/api/connect/callback";
}

function connectPage(worked: bool, detail: string): Reply {
  return reply(200, connectPageHtml(worked, detail), "text/html; charset=utf-8");
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
    let v: ConnectStarted = { url: began.url };
    return okJson(v);
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
    let v: SuppliedClientView = { clientId: suppliedClientId(this.db, id, this.master) };
    return okJson(v);
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

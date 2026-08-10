import { Db } from "../../../plume/driver.ts";
import { existsById, findById } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, NoContent, NotFound, OkJson, Refused, Respond } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { beginConnect, completeConnect, disconnect, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "../../connect.ts";
import { owningTag } from "../../owner.ts";
import { McpServerRow, mcpServersMapping } from "../../schema.ts";
import { ConnectStarted, SuppliedClientAsk, SuppliedClientView } from "./types.ts";
import { connectPageHtml } from "./page.ts";

function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") {
    return "";
  }
  while (origin.endsWith("/")) {
    origin = origin.slice(0, origin.length - 1);
  }
  return origin + "/api/connect/callback";
}

function connectPage(worked: bool, detail: string): Reply {
  return Respond(200, connectPageHtml(worked, detail), "text/html; charset=utf-8");
}

@controller("/connect")
@bindings
export class ConnectApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Post("/:id/start")
  start(req: Request, @PathVariable("id") id: string): Reply {
    let document = findById(this.db, mcpServersMapping(), id);
    if (document == "") {
      return NotFound("server " + id);
    }
    let server: McpServerRow = JSON.parse<McpServerRow>(document);
    let began = beginConnect(this.db, server, owningTag(callerTags(req)), this.master, callbackUri());
    if (began.problem != "") {
      return BadRequest(began.problem);
    }
    let v: ConnectStarted = { url: began.url };
    return OkJson(v);
  }

  @Get("/callback")
  callback(req: Request): Reply {
    let refused = req.query.get("error") ?? "";
    if (refused != "") {
      let said = req.query.get("error_description") ?? "";
      return connectPage(false, said == "" ? refused : said);
    }
    let done = completeConnect(this.db, this.master,
      req.query.get("state") ?? "", req.query.get("code") ?? "");
    if (done.problem != "") {
      return connectPage(false, done.problem);
    }
    return connectPage(true, done.serverName);
  }

  @Put("/:id/client")
  setClient(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    let ask: SuppliedClientAsk = JSON.parse<SuppliedClientAsk>(req.body);
    let refused = setSuppliedClient(this.db, id, ask.clientId, ask.clientSecret, this.master);
    if (refused != "") {
      return BadRequest(refused);
    }
    let v: SuppliedClientView = { clientId: suppliedClientId(this.db, id, this.master) };
    return OkJson(v);
  }

  @Delete("/:id/client")
  dropClient(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    forgetSuppliedClient(this.db, id);
    return NoContent();
  }

  @Delete("/:id")
  drop(req: Request, @PathVariable("id") id: string): Reply {
    if (!existsById(this.db, mcpServersMapping(), id)) {
      return NotFound("server " + id);
    }
    disconnect(this.db, id, owningTag(callerTags(req)));
    return NoContent();
  }
}

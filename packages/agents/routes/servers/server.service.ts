import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { accessTokenFor, connectionOf, forgetConnector, setToolOn, suppliedClientId, toolsOff, userTokenKey } from "../../connect.ts";
import { DestinationMove, destinationFault, forgetCredential, hasCredential, storeCredential } from "../../credentials.ts";
import { forgetRoster, rememberRoster, rosterOf, rosterWithSwitches } from "../../mcp-roster.ts";
import { toolListing } from "../../mcp.ts";
import { jsonId } from "../../payload.ts";
import { ConnectionView } from "./dtos/connection-view.dto.ts";
import { MineAsk } from "./dtos/mine-ask.dto.ts";
import { ServerAuth } from "./dtos/server-auth.dto.ts";
import { ServerBody } from "./dtos/server-body.dto.ts";
import { ServerToolsView } from "./dtos/server-tools-view.dto.ts";
import { StoredView } from "./dtos/stored-view.dto.ts";
import { ToolSwitch } from "./dtos/tool-switch.dto.ts";
import { ServerRepository } from "./server.repository.ts";
import { StaleTools, clearAuthWith, staleToolsJson, toolViews } from "./server.utils.ts";

export class ServerService {
  repository: ServerRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new ServerRepository(database);
    this.master = master;
  }

  listing(): string {
    return this.repository.listing();
  }

  one(id: string): string {
    return this.repository.one(id);
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  movedFault(row: ServerBody): string {
    let held = this.repository.one(row.id);
    let was = "";
    if (held != "") {
      was = JSON.parse<ServerBody>(held).endpoint;
    }
    let move: DestinationMove = {
      subject: "server " + row.id,
      secretName: "its token",
      clearWith: clearAuthWith(row.id),
      was: was,
      now: row.endpoint,
      secretStored: hasCredential(this.repository.database, "mcp:" + row.id),
    };
    return destinationFault(move);
  }

  tools(id: string, owner: string): string {
    let server: ServerBody = JSON.parse<ServerBody>(this.repository.one(id));
    let listed = toolListing(server, accessTokenFor(this.repository.database, server, owner, this.master));
    let declined = toolsOff(this.repository.database, server.id);

    if (listed.fault == "") {
      rememberRoster(this.repository.database, server.id, listed.tools, stamp());
    } else {
      let held = rosterOf(this.repository.database, server.id);
      if (held.listedAt != "") {
        let stale: StaleTools = {
          serverId: server.id,
          fault: listed.fault,
          listedAt: held.listedAt,
          tools: rosterWithSwitches(held.tools, declined),
        };
        return staleToolsJson(stale);
      }
    }

    let view: ServerToolsView = {
      serverId: server.id,
      fault: listed.fault,
      stale: false,
      listedAt: "",
      tools: toolViews(listed.tools, declined),
    };
    return JSON.stringify(view);
  }

  create(document: string): Outcome {
    let fault = this.repository.creationFault(document);
    if (fault != "") {
      return refusing(fault);
    }
    let body: ServerBody = JSON.parse<ServerBody>(document);
    if (body.transport != "http") {
      return refusing("this speaks http; \"" + body.transport + "\" needs a subprocess it cannot spawn");
    }
    let moved = this.movedFault(body);
    if (moved != "") {
      return refusing(moved);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(jsonId(document)));
  }

  update(id: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    let row: ServerBody = JSON.parse<ServerBody>(document);
    if (row.id != id) {
      return refusing("the id in the body must match the path");
    }
    if (row.serverName.trim() == "") {
      return refusing("a server needs a name");
    }
    if (row.transport != "http") {
      return refusing("this speaks http; \"" + row.transport + "\" needs a subprocess it cannot spawn");
    }
    if (row.endpoint.trim() == "") {
      return refusing("a server needs an endpoint");
    }
    let moved = this.movedFault(row);
    if (moved != "") {
      return refusing(moved);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  setAuth(id: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    let body: ServerAuth = JSON.parse<ServerAuth>(document);
    if (body.authKind != "none" && body.authKind != "bearer"
        && body.authKind != "header" && body.authKind != "oauth") {
      return refusing("auth is none, bearer, header or oauth, not \"" + body.authKind + "\"");
    }
    if (body.authKind == "header" && body.authHeader.trim() == "") {
      return refusing("a custom header needs a name");
    }
    if (body.authKind != "none" && body.authKind != "oauth" && body.token == "") {
      return refusing("that auth kind needs a token");
    }
    if (body.authKind == "oauth" && body.token != "") {
      return refusing("an OAuth connector is signed in to, not given a token — press Connect");
    }
    let written = this.repository.setAuth(id, body.authKind, body.authHeader);
    if (!written.ok) {
      return refusing(written.error);
    }
    if (body.authKind == "none") {
      forgetConnector(this.repository.database, id, this.master);
      return produced(this.repository.one(id));
    }
    if (body.authKind == "oauth") {
      return produced(this.repository.one(id));
    }
    let stored = storeCredential(this.repository.database, { provider: "mcp:" + id,
      apiKey: body.token, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return refusing(stored);
    }
    return produced(this.repository.one(id));
  }

  setTool(id: string, tool: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    let body: ToolSwitch = JSON.parse<ToolSwitch>(document);
    if (tool.trim() == "") {
      return refusing("a tool needs a name");
    }
    setToolOn(this.repository.database, id, tool, body.on);
    return produced("");
  }

  setMine(id: string, owner: string, document: string): Outcome {
    if (owner == "") {
      return refusing("a personal token needs a signed-in person — this deployment saw nobody");
    }
    if (document == "") {
      return refusing("a body is required");
    }
    let asked: MineAsk = JSON.parse<MineAsk>(document);
    if (asked.token == "") {
      return refusing("a token is required — to stop using your own, DELETE this route instead");
    }
    let stored = storeCredential(this.repository.database, { provider: userTokenKey(id, owner),
      apiKey: asked.token, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return refusing(stored);
    }
    let kept: StoredView = { stored: true };
    return produced(JSON.stringify(kept));
  }

  mine(id: string, owner: string): StoredView {
    if (owner == "") {
      let none: StoredView = { stored: false };
      return none;
    }
    let held: StoredView = {
      stored: hasCredential(this.repository.database, userTokenKey(id, owner)),
    };
    return held;
  }

  forgetMine(id: string, owner: string): Outcome {
    if (owner == "") {
      return refusing("nobody is signed in, so there is nothing of theirs to forget");
    }
    forgetCredential(this.repository.database, userTokenKey(id, owner));
    return produced("");
  }

  forgetStoredServer(id: string): string {
    let fault = this.repository.forget(id);
    forgetCredential(this.repository.database, "mcp:" + id);
    return fault;
  }

  forget(id: string): string {
    let fault = this.forgetStoredServer(id);
    forgetConnector(this.repository.database, id, this.master);
    forgetRoster(this.repository.database, id);
    return fault;
  }

  connections(owner: string): ConnectionView[] {
    let rows: ServerBody[] = JSON.parse<ServerBody[]>(this.repository.listing());
    let views: ConnectionView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let held = connectionOf(this.repository.database, rows[i].id, owner);
      let one: ConnectionView = {
        serverId: rows[i].id,
        authKind: rows[i].authKind,
        state: held.state,
        whose: held.whose,
        clientId: suppliedClientId(this.repository.database, rows[i].id, this.master),
        connectedAt: held.connectedAt,
      };
      views.push(one);
      i = i + 1;
    }
    return views;
  }
}

export function serverDestinationFault(database: Db, row: ServerBody): string {
  return new ServerService(database, "").movedFault(row);
}

export function forgetServer(database: Db, serverId: string): void {
  new ServerService(database, "").forgetStoredServer(serverId);
}

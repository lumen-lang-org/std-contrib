import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { Completed, beginConnect as openConnector, completeConnect, disconnect as disconnectConnector, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "../../connect.ts";
import { ConnectorBody } from "./dtos/connector-body.dto.ts";
import { ConnectStarted } from "./dtos/connect-started.dto.ts";
import { SuppliedClientAsk } from "./dtos/supplied-client-ask.dto.ts";
import { SuppliedClientView } from "./dtos/supplied-client-view.dto.ts";
import { ConnectRepository } from "./connect.repository.ts";

export class ConnectService {
  repository: ConnectRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new ConnectRepository(database);
    this.master = master;
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  openFlow(id: string, owner: string, redirectUri: string): Outcome {
    let server: ConnectorBody = JSON.parse<ConnectorBody>(this.repository.one(id));
    let began = openConnector(this.repository.database, server, owner, this.master, redirectUri);
    if (began.fault != "") {
      return refusing(began.fault);
    }
    let started: ConnectStarted = { url: began.url };
    return produced(JSON.stringify(started));
  }

  callback(state: string, code: string): Completed {
    return completeConnect(this.repository.database, this.master, state, code);
  }

  setClient(id: string, document: string): Outcome {
    let ask: SuppliedClientAsk = JSON.parse<SuppliedClientAsk>(document);
    let refused = setSuppliedClient(this.repository.database, id, ask.clientId, ask.clientSecret, this.master);
    if (refused != "") {
      return refusing(refused);
    }
    let view: SuppliedClientView = {
      clientId: suppliedClientId(this.repository.database, id, this.master),
    };
    return produced(JSON.stringify(view));
  }

  dropClient(id: string): void {
    forgetSuppliedClient(this.repository.database, id);
  }

  dropConnection(id: string, owner: string): bool {
    return disconnectConnector(this.repository.database, id, owner);
  }
}

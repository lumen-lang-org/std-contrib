import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, masterKeyFault, providersWithCredentials, storeCredential } from "../../credentials.ts";
import { KeyBody } from "./dtos/key-body.dto.ts";
import { ProviderStatus } from "./dtos/provider-status.dto.ts";

export class ProviderService {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  listing(): string[] {
    return providersWithCredentials(this.database);
  }

  status(provider: string): ProviderStatus {
    let usable = credentialFor(this.database, provider, this.master) != "";
    return { provider: provider, configured: usable };
  }

  setKey(provider: string, body: KeyBody): Outcome {
    let fault = masterKeyFault(this.master);
    if (fault != "") {
      return refusing(fault);
    }
    let stored = storeCredential(this.database, {
      provider: provider,
      apiKey: body.apiKey,
      masterKey: this.master,
      now: stamp(),
    });
    if (stored != "") {
      return refusing(stored);
    }
    let v: ProviderStatus = { provider: provider, configured: true };
    return produced(JSON.stringify(v));
  }

  clearKey(provider: string): bool {
    return forgetCredential(this.database, provider);
  }
}

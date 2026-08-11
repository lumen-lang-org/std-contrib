import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, hasCredential, storeCredential } from "../../credentials.ts";
import { AuthProviderAsk } from "./dtos/auth-provider-ask.dto.ts";
import { AuthProviderResolvedView } from "./dtos/auth-provider-resolved-view.dto.ts";
import { AuthProviderRecord } from "./dtos/auth-provider-record.dto.ts";
import { AuthProviderSecretStored } from "./dtos/auth-provider-secret-stored.dto.ts";
import { AuthProviderView } from "./dtos/auth-provider-view.dto.ts";
import { AuthProviderRepository } from "./auth-provider.repository.ts";
import { authProviderFault, kindOrDefault } from "./auth-provider.utils.ts";

export class AuthProviderService {
  repository: AuthProviderRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new AuthProviderRepository(database);
    this.master = master;
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  listing(): AuthProviderView[] {
    let rows: AuthProviderRecord[] = JSON.parse<AuthProviderRecord[]>(this.repository.listing());
    let views: AuthProviderView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: AuthProviderView = {
        id: rows[i].id,
        label: rows[i].label,
        kind: kindOrDefault(rows[i].kind),
        issuer: rows[i].issuer,
        clientId: rows[i].clientId,
        scopes: rows[i].scopes,
        enabled: rows[i].enabled,
        configured: hasCredential(this.repository.database, "oauth:" + rows[i].id),
      };
      views.push(one);
      i = i + 1;
    }
    return views;
  }

  resolved(): AuthProviderResolvedView[] {
    let rows: AuthProviderRecord[] = JSON.parse<AuthProviderRecord[]>(this.repository.enabledListing());
    let views: AuthProviderResolvedView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let secret = credentialFor(this.repository.database, "oauth:" + rows[i].id, this.master);
      if (secret != "") {
        let one: AuthProviderResolvedView = {
          id: rows[i].id,
          label: rows[i].label,
          kind: kindOrDefault(rows[i].kind),
          issuer: rows[i].issuer,
          clientId: rows[i].clientId,
          clientSecret: secret,
          scopes: rows[i].scopes,
        };
        views.push(one);
      }
      i = i + 1;
    }
    return views;
  }

  create(ask: AuthProviderAsk, document: string): Outcome {
    let fault = this.repository.creationFault(document);
    if (fault != "") {
      return refusing(fault);
    }
    let bad = authProviderFault(ask);
    if (bad != "") {
      return refusing(bad);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(ask.id));
  }

  update(id: string, ask: AuthProviderAsk, document: string): Outcome {
    if (ask.id != id) {
      return refusing("the id in the body must match the path");
    }
    let bad = authProviderFault(ask);
    if (bad != "") {
      return refusing(bad);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  setSecret(id: string, secret: string): Outcome {
    let stored = storeCredential(this.repository.database, { provider: "oauth:" + id,
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return refusing(stored);
    }
    let v: AuthProviderSecretStored = { configured: true };
    return produced(JSON.stringify(v));
  }

  forget(id: string): Outcome {
    forgetCredential(this.repository.database, "oauth:" + id);
    let gone = this.repository.remove(id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }
}

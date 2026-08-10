import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, badRequest, noContent, notFound, okJson, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, masterKey, masterKeyProblem, providersWithCredentials, storeCredential } from "../../credentials.ts";
import { KeyBody, ProviderStatus } from "./types.ts";

@controller("/providers")
@bindings
export class ProviderApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  list(): Reply {
    let names: string[] = providersWithCredentials(this.db);
    return okJson(names);
  }

  @get("/:provider")
  status(@PathVariable("provider") provider: string): Reply {
    let usable = credentialFor(this.db, provider, this.master) != "";
    let v: ProviderStatus = { provider: provider, configured: usable };
    return okJson(v);
  }

  @put("/:provider/key")
  setKey(@PathVariable("provider") provider: string, @Valid @RequestBody body: KeyBody): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") { return badRequest(problem); }
    let stored = storeCredential(this.db, { provider: provider, apiKey: body.apiKey, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    let v: ProviderStatus = { provider: provider, configured: true };
    return okJson(v);
  }

  @del("/:provider/key")
  clearKey(@PathVariable("provider") provider: string): Reply {
    if (!forgetCredential(this.db, provider)) {
      return notFound("no key for " + provider);
    }
    return noContent();
  }
}

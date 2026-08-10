import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, okJson, param, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, masterKey, masterKeyProblem, providersWithCredentials, storeCredential } from "../../credentials.ts";
import { KeyBody, ProviderStatus } from "./types.ts";

@controller("/providers")
export class ProviderApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @get("/")
  list(req: Request): Reply {
    let names: string[] = providersWithCredentials(this.db);
    return okJson(names);
  }

  @get("/:provider")
  status(req: Request): Reply {
    let usable = credentialFor(this.db, param(req, "provider"), this.master) != "";
    let v: ProviderStatus = { provider: param(req, "provider"), configured: usable };
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
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, param(req, "provider"))) {
      return notFound("no key for " + param(req, "provider"));
    }
    return noContent();
  }
}

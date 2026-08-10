// The /providers routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { stamp } from "./api-core.ts";
import { credentialFor, forgetCredential, masterKey, masterKeyProblem, providersWithCredentials, storeCredential } from "./credentials.ts";

type KeyBody = { apiKey: string };

// Credentials, over the API. A key can be written and named; it can never be
// read back. Anything that returns one is a leak waiting for a log line, and
// the caller who set it already knows what they set.
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
    let names = providersWithCredentials(this.db);
    let out = "[";
    let i: int = 0;
    while (i < names.length) {
      if (i > 0) { out = out + ","; }
      out = out + JSON.stringify(names[i]);
      i = i + 1;
    }
    return ok(out + "]");
  }

  // Whether a provider has a usable key, without saying what it is. A caller
  // needs to know a deployment is configured; it does not need the secret to
  // find that out.
  @get("/:provider")
  status(req: Request): Reply {
    let usable = credentialFor(this.db, param(req, "provider"), this.master) != "";
    return ok("{\"provider\":" + JSON.stringify(param(req, "provider"))
      + ",\"configured\":" + `${usable}` + "}");
  }

  @put("/:provider/key")
  setKey(req: Request): Reply {
    let problem = masterKeyProblem(this.master);
    if (problem != "") { return badRequest(problem); }
    if (req.body == "") { return badRequest("a body is required"); }
    let body: KeyBody = JSON.parse<KeyBody>(req.body);
    let stored = storeCredential(this.db, { provider: param(req, "provider"), apiKey: body.apiKey, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"provider\":" + JSON.stringify(param(req, "provider")) + ",\"configured\":true}");
  }

  @del("/:provider/key")
  clearKey(req: Request): Reply {
    if (!forgetCredential(this.db, param(req, "provider"))) {
      return notFound("no key for " + param(req, "provider"));
    }
    return noContent();
  }
}

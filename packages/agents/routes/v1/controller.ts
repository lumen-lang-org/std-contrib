import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, header, ok, problem } from "../../../rest/server.ts";
import { forwardProduct, stamp } from "../../api-core.ts";
import { hasScope, touchApiKey, verifyApiKey } from "../../api-keys.ts";
import { presentedKey } from "../../search-gateway.ts";

@controller("/v1")
@bindings
export class V1Api {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/search")
  search(req: Request): Reply { return this.gated(req, "search"); }

  @get("/retrieve")
  retrieve(req: Request): Reply { return this.gated(req, "retrieve"); }

  @get("/suggest")
  suggest(req: Request): Reply { return this.gated(req, "suggest"); }

  gated(req: Request, product: string): Reply {
    let secret = presentedKey(header(req, "authorization"), header(req, "x-api-key"));
    let auth = verifyApiKey(this.db, secret);
    if (!auth.ok) {
      return problem(401, "a valid API key is required — send it as \"Authorization: Bearer jl_...\" or an X-API-Key header");
    }
    if (!hasScope(auth.scopes, product)) {
      return problem(403, "this key is not scoped for " + product + " — mint one with that scope on the Platform page");
    }
    let out = forwardProduct(req, product);
    touchApiKey(this.db, auth.keyId, stamp());
    return out;
  }
}

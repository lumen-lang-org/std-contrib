// The /v1 routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, header, ok, problem } from "../rest/server.ts";
import { forwardProduct, stamp } from "./api-core.ts";
import { hasScope, touchApiKey, verifyApiKey } from "./api-keys.ts";
import { presentedKey } from "./search-gateway.ts";

// The public product API, reached with an API key. Its own front-door
// exemption (publicPath) lets a jl_ key past the internal token and the proxy
// identity check, because this door authenticates the key itself and nothing
// else. Scopes gate which product a key may call; a use is stamped after a
// forward so the key list can say a key is alive.
@controller("/v1")
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

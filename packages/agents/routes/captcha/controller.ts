import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, ok, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { utf8Length } from "../../artifacts.ts";
import { credentialFor, hasCredential, masterKey, storeCredential } from "../../credentials.ts";
import { jsonFlag, jsonText } from "../../scan.ts";
import { readSetting, writeSetting } from "../../schema.ts";

// The /captcha routes.

@controller("/captcha")
export class CaptchaApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  // The operator's view: everything except the secret, which is never read
  // back. `configured` is the question the form actually asks — "is there a
  // secret stored" — answered without opening it.
  @get("/")
  show(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    let provider = held == "" ? "turnstile" : jsonText(held, "provider");
    let siteKey = held == "" ? "" : jsonText(held, "siteKey");
    let enabled = held != "" && jsonText(held, "enabled") == "true";
    return ok("{\"provider\":" + JSON.stringify(provider)
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"enabled\":" + (enabled ? "true" : "false")
      + ",\"configured\":" + (hasCredential(this.db, "captcha") ? "true" : "false") + "}");
  }

  // What the console's own server needs to verify a token: the secret. Its own
  // route because it is the one place this secret leaves the process, exactly
  // as /auth-providers/resolved is for OAuth — and it answers the enabled and
  // fully-configured case only, so a half-set-up challenge cannot lock anybody
  // out of a login form.
  @get("/resolved")
  resolved(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    if (held == "") { return ok("{\"enabled\":false}"); }
    let enabled = jsonText(held, "enabled") == "true";
    let siteKey = jsonText(held, "siteKey");
    let secret = credentialFor(this.db, "captcha", this.master);
    if (!enabled || siteKey == "" || secret == "") { return ok("{\"enabled\":false}"); }
    return ok("{\"enabled\":true,\"provider\":" + JSON.stringify(jsonText(held, "provider"))
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"secret\":" + JSON.stringify(secret) + "}");
  }

  @put("/")
  change(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let provider = jsonText(req.body, "provider");
    if (provider == "") { provider = "turnstile"; }
    if (provider != "turnstile" && provider != "hcaptcha" && provider != "recaptcha") {
      return badRequest("provider must be turnstile, hcaptcha or recaptcha");
    }
    let siteKey = jsonText(req.body, "siteKey");
    if (utf8Length(siteKey) > 200) { return badRequest("that is not a site key"); }
    let enabled = jsonFlag(req.body, "enabled", false);
    // Refusing here rather than at the console: turning the challenge on with
    // no secret stored would mean every verification fails, which locks the
    // login form for everybody including the operator who just did it.
    if (enabled && (siteKey == "" || !hasCredential(this.db, "captcha"))) {
      return badRequest("store a site key and a secret before turning the challenge on");
    }
    let value = "{\"provider\":" + JSON.stringify(provider)
      + ",\"siteKey\":" + JSON.stringify(siteKey)
      + ",\"enabled\":" + (enabled ? "\"true\"" : "\"false\"") + "}";
    let problem = writeSetting(this.db, "captcha", value);
    if (problem != "") { return badRequest(problem); }
    return ok(value);
  }

  @put("/secret")
  setSecret(req: Request): Reply {
    let secret = jsonText(req.body, "secret");
    if (secret == "") { return badRequest("a secret is required"); }
    let stored = storeCredential(this.db, { provider: "captcha",
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    return ok("{\"configured\":true}");
  }
}

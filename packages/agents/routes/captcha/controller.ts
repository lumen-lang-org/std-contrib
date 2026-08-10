import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, okJson, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { utf8Length } from "../../artifacts.ts";
import { credentialFor, hasCredential, masterKey, storeCredential } from "../../credentials.ts";
import { jsonFlag, jsonText } from "../../scan.ts";
import { readSetting, writeSetting } from "../../schema.ts";
import { CaptchaOff, CaptchaResolved, CaptchaSecretStored, CaptchaSetting, CaptchaView } from "./types.ts";

@controller("/captcha")
export class CaptchaApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  show(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    let provider = held == "" ? "turnstile" : jsonText(held, "provider");
    let siteKey = held == "" ? "" : jsonText(held, "siteKey");
    let enabled = held != "" && jsonText(held, "enabled") == "true";
    let v: CaptchaView = { provider: provider, siteKey: siteKey, enabled: enabled,
      configured: hasCredential(this.db, "captcha") };
    return okJson(v);
  }

  @get("/resolved")
  resolved(req: Request): Reply {
    let held = readSetting(this.db, "captcha");
    if (held == "") {
      let off: CaptchaOff = { enabled: false };
      return okJson(off);
    }
    let enabled = jsonText(held, "enabled") == "true";
    let siteKey = jsonText(held, "siteKey");
    let secret = credentialFor(this.db, "captcha", this.master);
    if (!enabled || siteKey == "" || secret == "") {
      let off: CaptchaOff = { enabled: false };
      return okJson(off);
    }
    let v: CaptchaResolved = { enabled: true, provider: jsonText(held, "provider"),
      siteKey: siteKey, secret: secret };
    return okJson(v);
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
    if (enabled && (siteKey == "" || !hasCredential(this.db, "captcha"))) {
      return badRequest("store a site key and a secret before turning the challenge on");
    }
    let v: CaptchaSetting = { provider: provider, siteKey: siteKey,
      enabled: enabled ? "true" : "false" };
    let problem = writeSetting(this.db, "captcha", JSON.stringify(v));
    if (problem != "") { return badRequest(problem); }
    return okJson(v);
  }

  @put("/secret")
  setSecret(req: Request): Reply {
    let secret = jsonText(req.body, "secret");
    if (secret == "") { return badRequest("a secret is required"); }
    let stored = storeCredential(this.db, { provider: "captcha",
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    let v: CaptchaSecretStored = { configured: true };
    return okJson(v);
  }
}

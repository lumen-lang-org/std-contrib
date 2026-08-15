import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { credentialFor, hasCredential, storeCredential } from "../../../credentials.ts";
import { jsonText } from "../../../scan.ts";
import { CaptchaRepository } from "./captcha.repository.ts";
import { CaptchaAsk } from "./dtos/captcha-ask.dto.ts";
import { CaptchaOff } from "./dtos/captcha-off.dto.ts";
import { CaptchaResolved } from "./dtos/captcha-resolved.dto.ts";
import { CaptchaSecretStored } from "./dtos/captcha-secret-stored.dto.ts";
import { CaptchaSetting } from "./dtos/captcha-setting.dto.ts";
import { CaptchaView } from "./dtos/captcha-view.dto.ts";
import { SettingRecord } from "./dtos/setting-record.dto.ts";

export class CaptchaService {
  repository: CaptchaRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new CaptchaRepository(database);
    this.master = master;
  }

  storedValue(): string {
    let held = this.repository.held();
    if (held == "") {
      return "";
    }
    let row: SettingRecord = JSON.parse<SettingRecord>(held);
    return row.value;
  }

  view(): CaptchaView {
    let held = this.storedValue();
    let provider = held == "" ? "turnstile" : jsonText(held, "provider");
    let siteKey = held == "" ? "" : jsonText(held, "siteKey");
    let enabled = held != "" && jsonText(held, "enabled") == "true";
    let v: CaptchaView = { provider: provider, siteKey: siteKey, enabled: enabled,
      configured: hasCredential(this.repository.database, "captcha") };
    return v;
  }

  resolvedDocument(): string {
    let held = this.storedValue();
    if (held == "") {
      let off: CaptchaOff = { enabled: false };
      return JSON.stringify(off);
    }
    let enabled = jsonText(held, "enabled") == "true";
    let siteKey = jsonText(held, "siteKey");
    let secret = credentialFor(this.repository.database, "captcha", this.master);
    if (!enabled || siteKey == "" || secret == "") {
      let off: CaptchaOff = { enabled: false };
      return JSON.stringify(off);
    }
    let v: CaptchaResolved = { enabled: true, provider: jsonText(held, "provider"),
      siteKey: siteKey, secret: secret };
    return JSON.stringify(v);
  }

  change(ask: CaptchaAsk): Outcome {
    if (ask.enabled && (ask.siteKey == "" || !hasCredential(this.repository.database, "captcha"))) {
      return refusing("store a site key and a secret before turning the challenge on");
    }
    let v: CaptchaSetting = {
      provider: ask.provider == "" ? "turnstile" : ask.provider,
      siteKey: ask.siteKey,
      enabled: ask.enabled ? "true" : "false",
    };
    let written = this.repository.write(JSON.stringify(v));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(JSON.stringify(v));
  }

  setSecret(body: string): Outcome {
    let secret = jsonText(body, "secret");
    if (secret == "") {
      return refusing("a secret is required");
    }
    let stored = storeCredential(this.repository.database, { provider: "captcha",
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return refusing(stored);
    }
    let v: CaptchaSecretStored = { configured: true };
    return produced(JSON.stringify(v));
  }
}

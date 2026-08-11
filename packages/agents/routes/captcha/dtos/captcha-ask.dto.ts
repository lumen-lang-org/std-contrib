import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class CaptchaAsk {
  @oneOf("turnstile,hcaptcha,recaptcha", "provider must be turnstile, hcaptcha or recaptcha")
  provider: string;

  @maxLength(200, "that is not a site key")
  siteKey: string;

  enabled: bool;

  constructor(provider: string, siteKey: string, enabled: bool) {
    this.provider = provider;
    this.siteKey = siteKey;
    this.enabled = enabled;
  }
}

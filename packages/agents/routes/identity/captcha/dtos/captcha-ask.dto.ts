import { Rule, validated, MaxLength, OneOf } from "../../../../../validation/validation.ts";

@validated
export class CaptchaAsk {
  @OneOf("turnstile,hcaptcha,recaptcha", "provider must be turnstile, hcaptcha or recaptcha")
  provider: string;

  @MaxLength(200, "that is not a site key")
  siteKey: string;

  enabled: bool;

  constructor(provider: string, siteKey: string, enabled: bool) {
    this.provider = provider;
    this.siteKey = siteKey;
    this.enabled = enabled;
  }
}

import { validated, Rule } from "../../../validation/validation.ts";

export type CaptchaView = {
  provider: string,
  siteKey: string,
  enabled: bool,
  configured: bool,
};

export type CaptchaOff = { enabled: bool };

export type CaptchaResolved = {
  enabled: bool,
  provider: string,
  siteKey: string,
  secret: string,
};

export type CaptchaSetting = {
  provider: string,
  siteKey: string,
  enabled: string,
};

export type CaptchaSecretStored = { configured: bool };

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

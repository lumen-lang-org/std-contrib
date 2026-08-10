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

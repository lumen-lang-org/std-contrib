import { validated, Rule } from "../../../validation/validation.ts";

export type AuthProviderView = {
  id: string,
  label: string,
  kind: string,
  issuer: string,
  clientId: string,
  scopes: string,
  enabled: bool,
  configured: bool,
};

export type AuthProviderResolvedView = {
  id: string,
  label: string,
  kind: string,
  issuer: string,
  clientId: string,
  clientSecret: string,
  scopes: string,
};

export type AuthProviderSecretStored = { configured: bool };

@validated
export class AuthProviderAsk {
  @required("a provider needs an id — it is what the callback URL carries")
  id: string;

  @required("a provider needs a label — it is what the sign-in button says")
  label: string;

  @oneOf("oidc,github", "kind is 'oidc' or 'github'")
  kind: string;

  issuer: string;

  @required("a client id is required")
  clientId: string;

  scopes: string;

  enabled: bool;

  constructor(id: string, label: string, kind: string, issuer: string,
              clientId: string, scopes: string, enabled: bool) {
    this.id = id;
    this.label = label;
    this.kind = kind;
    this.issuer = issuer;
    this.clientId = clientId;
    this.scopes = scopes;
    this.enabled = enabled;
  }
}

@validated
export class AuthProviderSecretAsk {
  @required("a client secret is required")
  clientSecret: string;

  constructor(clientSecret: string) {
    this.clientSecret = clientSecret;
  }
}

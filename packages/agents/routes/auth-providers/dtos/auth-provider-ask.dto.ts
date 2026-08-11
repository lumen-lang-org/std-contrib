import { Rule, validated, OneOf, Required } from "../../../../validation/validation.ts";

@validated
export class AuthProviderAsk {
  @Required("a provider needs an id — it is what the callback URL carries")
  id: string;

  @Required("a provider needs a label — it is what the sign-in button says")
  label: string;

  @OneOf("oidc,github", "kind is 'oidc' or 'github'")
  kind: string;

  issuer: string;

  @Required("a client id is required")
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

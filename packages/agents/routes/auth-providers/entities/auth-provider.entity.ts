import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("auth_providers")
export class AuthProvider {
  @id
  @column("id", "text")
  id: string;

  @column("label", "text")
  label: string;

  @column("kind", "text")
  kind: string;

  @column("issuer", "text")
  issuer: string;

  @column("client_id", "text")
  clientId: string;

  @column("scopes", "text")
  scopes: string;

  @column("enabled", "bool")
  enabled: bool;

  constructor(id: string, label: string, kind: string, issuer: string, clientId: string,
              scopes: string, enabled: bool) {
    this.id = id;
    this.label = label;
    this.kind = kind;
    this.issuer = issuer;
    this.clientId = clientId;
    this.scopes = scopes;
    this.enabled = enabled;
  }
}

export function authProviderRepository(): DbRepository {
  return entityAuthProvider;
}

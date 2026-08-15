import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("auth_providers")
export class AuthProvider {
  @Id
  @Column("id", "text")
  id: string;

  @Column("label", "text")
  label: string;

  @Column("kind", "text")
  kind: string;

  @Column("issuer", "text")
  issuer: string;

  @Column("client_id", "text")
  clientId: string;

  @Column("scopes", "text")
  scopes: string;

  @Column("enabled", "bool")
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

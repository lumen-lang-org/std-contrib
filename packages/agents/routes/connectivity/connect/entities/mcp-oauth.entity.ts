import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("mcp_oauth")
export class McpOauth {
  @Id
  @Column("id", "text")
  id: string;

  @Column("issuer", "text")
  issuer: string;

  @Column("authorize_url", "text")
  authorizeUrl: string;

  @Column("token_url", "text")
  tokenUrl: string;

  @Column("client_id", "text")
  clientId: string;

  @Column("scope", "text")
  scope: string;

  @Column("redirect_uri", "text")
  redirectUri: string;

  @Column("registered_at", "text")
  registeredAt: string;

  constructor(id: string, issuer: string, authorizeUrl: string, tokenUrl: string,
              clientId: string, scope: string, redirectUri: string, registeredAt: string) {
    this.id = id;
    this.issuer = issuer;
    this.authorizeUrl = authorizeUrl;
    this.tokenUrl = tokenUrl;
    this.clientId = clientId;
    this.scope = scope;
    this.redirectUri = redirectUri;
    this.registeredAt = registeredAt;
  }
}

export function mcpOauthRepository(): DbRepository {
  return entityMcpOauth;
}

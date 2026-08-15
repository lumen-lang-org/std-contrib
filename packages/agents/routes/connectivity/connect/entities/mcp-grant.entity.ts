import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("mcp_oauth_grants")
export class McpGrant {
  @Id
  @Column("id", "text")
  id: string;

  @Column("server_id", "text")
  serverId: string;

  @Column("owner", "text")
  owner: string;

  @Column("expires_at", "text")
  expiresAt: string;

  @Column("refreshable", "bool")
  refreshable: bool;

  @Column("connected_at", "text")
  connectedAt: string;

  constructor(id: string, serverId: string, owner: string, expiresAt: string,
              refreshable: bool, connectedAt: string) {
    this.id = id;
    this.serverId = serverId;
    this.owner = owner;
    this.expiresAt = expiresAt;
    this.refreshable = refreshable;
    this.connectedAt = connectedAt;
  }
}

export function mcpGrantRepository(): DbRepository {
  return entityMcpGrant;
}

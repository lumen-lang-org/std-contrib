import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("mcp_oauth_pending")
export class McpPending {
  @Id
  @Column("id", "text")
  id: string;

  @Column("server_id", "text")
  serverId: string;

  @Column("owner", "text")
  owner: string;

  @Column("verifier", "text")
  verifier: string;

  @Column("started_at", "text")
  startedAt: string;

  constructor(id: string, serverId: string, owner: string, verifier: string, startedAt: string) {
    this.id = id;
    this.serverId = serverId;
    this.owner = owner;
    this.verifier = verifier;
    this.startedAt = startedAt;
  }
}

export function mcpPendingRepository(): DbRepository {
  return entityMcpPending;
}

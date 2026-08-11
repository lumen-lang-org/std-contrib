import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("mcp_servers")
export class McpServer {
  @Id
  @Column("id", "text")
  id: string;

  @Column("server_name", "text")
  serverName: string;

  @Column("transport", "text")
  transport: string;

  @Column("endpoint", "text")
  endpoint: string;

  @Column("auth_kind", "text")
  authKind: string;

  @Column("auth_header", "text")
  authHeader: string;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(id: string, serverName: string, transport: string, endpoint: string,
              authKind: string, authHeader: string, enabled: bool) {
    this.id = id;
    this.serverName = serverName;
    this.transport = transport;
    this.endpoint = endpoint;
    this.authKind = authKind;
    this.authHeader = authHeader;
    this.enabled = enabled;
  }
}

export function mcpServerRepository(): DbRepository {
  return entityMcpServer;
}

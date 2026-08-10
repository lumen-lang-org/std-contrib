import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("mcp_servers")
export class McpServer {
  @id
  @column("id", "text")
  id: string;

  @column("server_name", "text")
  serverName: string;

  @column("transport", "text")
  transport: string;

  @column("endpoint", "text")
  endpoint: string;

  @column("auth_kind", "text")
  authKind: string;

  @column("auth_header", "text")
  authHeader: string;

  @column("enabled", "bool")
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

import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("mcp_tools_off")
export class McpToolOff {
  @Id
  @Column("id", "text")
  id: string;

  @Column("server_id", "text")
  serverId: string;

  @Column("tool_name", "text")
  toolName: string;

  constructor(id: string, serverId: string, toolName: string) {
    this.id = id;
    this.serverId = serverId;
    this.toolName = toolName;
  }
}

export function mcpToolOffRepository(): DbRepository {
  return entityMcpToolOff;
}

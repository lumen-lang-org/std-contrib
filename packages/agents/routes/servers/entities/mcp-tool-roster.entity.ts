import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("mcp_tool_roster")
export class McpToolRoster {
  @Id
  @Column("id", "text")
  id: string;

  @Column("tools", "text")
  tools: string;

  @Column("listed_at", "text")
  listedAt: string;

  constructor(id: string, tools: string, listedAt: string) {
    this.id = id;
    this.tools = tools;
    this.listedAt = listedAt;
  }
}

export function mcpToolRosterRepository(): DbRepository {
  return entityMcpToolRoster;
}

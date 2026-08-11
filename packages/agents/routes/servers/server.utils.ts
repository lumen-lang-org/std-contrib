import { McpTool } from "../../mcp.ts";
import { ServerAuth } from "./dtos/server-auth.dto.ts";
import { ServerBody } from "./dtos/server-body.dto.ts";
import { ToolView } from "./dtos/tool-view.dto.ts";

export type StaleTools = {
  serverId: string,
  fault: string,
  listedAt: string,
  tools: string,
};

export function toolViews(tools: McpTool[], declined: string[]): ToolView[] {
  let views: ToolView[] = [];
  let i: int = 0;
  while (i < tools.length) {
    let one: ToolView = {
      name: tools[i].name,
      description: tools[i].description,
      on: !declined.includes(tools[i].name),
    };
    views.push(one);
    i = i + 1;
  }
  return views;
}

export function staleToolsJson(stale: StaleTools): string {
  return "{\"serverId\":" + JSON.stringify(stale.serverId)
    + ",\"fault\":" + JSON.stringify(stale.fault)
    + ",\"stale\":true,\"listedAt\":" + JSON.stringify(stale.listedAt)
    + ",\"tools\":" + stale.tools + "}";
}

export function clearAuthWith(id: string): string {
  return "PUT /servers/" + id + "/auth with {\"authKind\":\"none\",\"authHeader\":\"\",\"token\":\"\"}";
}

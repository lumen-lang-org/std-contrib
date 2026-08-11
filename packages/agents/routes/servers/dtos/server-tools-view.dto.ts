import { ToolView } from "./tool-view.dto.ts";

export type ServerToolsView = {
  serverId: string,
  fault: string,
  stale: bool,
  listedAt: string,
  tools: ToolView[],
};

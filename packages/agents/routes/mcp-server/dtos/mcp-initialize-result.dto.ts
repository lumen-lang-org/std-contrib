import { McpCapabilities } from "./mcp-capabilities.dto.ts";
import { McpServerInfo } from "./mcp-server-info.dto.ts";

export type McpInitializeResult = {
  protocolVersion: string,
  capabilities: McpCapabilities,
  serverInfo: McpServerInfo,
};

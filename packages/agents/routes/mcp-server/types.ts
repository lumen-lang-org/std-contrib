export type McpToolsCapability = {};

export type McpCapabilities = { tools: McpToolsCapability };

export type McpServerInfo = { name: string, version: string };

export type McpInitializeResult = {
  protocolVersion: string,
  capabilities: McpCapabilities,
  serverInfo: McpServerInfo,
};

export type McpAcknowledged = {};

export type McpTextBlock = { type: string, text: string };

export type McpCallResult = { content: McpTextBlock[], isError: bool };

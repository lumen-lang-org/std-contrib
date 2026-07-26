// The agents API, as typed calls. Everything goes through /api, which the
// Vite proxy (dev) or nginx (compose) forwards to the Lumen server — one
// origin everywhere, so CORS never comes up.

export type AgentRow = {
  id: string;
  agentName: string;
  description: string;
  modelConfigId: string;
  promptId: string;
  enabled: boolean;
};

export type ModelRow = {
  id: string;
  label: string;
  apiName: string;
  provider: string;
  kind: string;
  dimensions: number;
  enabled: boolean;
};

export type ModelConfigRow = {
  id: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  extra: string;
};

export type PromptRow = {
  id: string;
  promptName: string;
  version: number;
  content: string;
};

export type ServerRow = {
  id: string;
  serverName: string;
  transport: string;
  endpoint: string;
  enabled: boolean;
};

export type TracingStatus = {
  configured: boolean;
  active: boolean;
  backend: string;
  endpoint: string;
  serviceName: string;
  environment: string;
};

export type ThreadListing = {
  id: string;
  agentId: string;
  createdAt: string;
  title: string;
};

export type TranscriptTurn = { role: string; text: string };

export type WorkspaceFile = { name: string; mime: string; origin: string };

export type SayReply = {
  runId: string;
  ok: boolean;
  text: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  traceId: string;
  error: string;
};

const BASE = "/api";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.text();
  if (!res.ok) {
    // The API answers errors as {"error": "..."} — surface that sentence,
    // not a status code.
    let why = `HTTP ${res.status}`;
    try { why = (JSON.parse(body) as { error: string }).error ?? why; } catch { /* not JSON */ }
    throw new Error(why);
  }
  return (body === "" ? null : JSON.parse(body)) as T;
}

// --- conversation ---------------------------------------------------------------------

export const listAgents = () => call<AgentRow[]>("/agents");
export const listThreads = () => call<ThreadListing[]>("/threads?limit=50");
export const openThread = (agentId: string) =>
  call<{ id: string }>("/threads", { method: "POST", body: JSON.stringify({ agentId }) });
export const transcript = (id: string) =>
  call<TranscriptTurn[]>(`/threads/${encodeURIComponent(id)}`);
export const say = (id: string, text: string) =>
  call<SayReply>(`/threads/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

// --- workspace ------------------------------------------------------------------------

export const listFiles = (threadId: string) =>
  call<WorkspaceFile[]>(`/threads/${encodeURIComponent(threadId)}/files`);
export const readFile = (threadId: string, name: string) =>
  call<{ name: string; mime: string; origin: string; content: string }>(
    `/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(name)}`);
export const uploadFile = (threadId: string, name: string, content: string) =>
  call<unknown>(`/threads/${encodeURIComponent(threadId)}/files`, {
    method: "POST",
    body: JSON.stringify({ name, content }),
  });

// --- configuration --------------------------------------------------------------------

export const listModels = () => call<ModelRow[]>("/models");
export const createModel = (row: ModelRow) =>
  call<ModelRow>("/models", { method: "POST", body: JSON.stringify(row) });
export const setModelEnabled = (id: string, enabled: boolean) =>
  call<unknown>(`/models/${encodeURIComponent(id)}/enabled`, {
    method: "PUT", body: JSON.stringify({ enabled }),
  });

export const listConfigs = () => call<ModelConfigRow[]>("/model-configs");
export const createConfig = (row: ModelConfigRow) =>
  call<ModelConfigRow>("/model-configs", { method: "POST", body: JSON.stringify(row) });

export const listPrompts = () => call<PromptRow[]>("/prompts");
export const createPrompt = (promptName: string, content: string) =>
  call<PromptRow>("/prompts", {
    method: "POST",
    body: JSON.stringify({ id: "", promptName, version: 0, content, createdAt: "" }),
  });

export const listServers = () => call<ServerRow[]>("/servers");
export const createServer = (row: ServerRow) =>
  call<ServerRow>("/servers", { method: "POST", body: JSON.stringify(row) });

export const listProviders = () => call<string[]>("/providers");
export const storeProviderKey = (provider: string, apiKey: string) =>
  call<unknown>(`/providers/${encodeURIComponent(provider)}/key`, {
    method: "PUT", body: JSON.stringify({ apiKey }),
  });

export const tracingStatus = () => call<TracingStatus>("/tracing");
export const configureTracing = (row: {
  id: string; backend: string; endpoint: string; publicKey: string;
  serviceName: string; environment: string; enabled: boolean;
}) => call<unknown>("/tracing", { method: "PUT", body: JSON.stringify(row) });
export const setTracingSecret = (secretKey: string) =>
  call<unknown>("/tracing/key", { method: "PUT", body: JSON.stringify({ secretKey }) });

export const setAgentModel = (agentId: string, modelConfigId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/model`, {
    method: "PUT", body: JSON.stringify({ modelConfigId }),
  });
export const setAgentPrompt = (agentId: string, promptId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/prompt`, {
    method: "PUT", body: JSON.stringify({ promptId }),
  });
export const createAgent = (row: AgentRow) =>
  call<AgentRow>("/agents", {
    method: "POST",
    body: JSON.stringify({ ...row, updatedAt: "now", description: row.description ?? "" }),
  });

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
  // `body`, not `content` — the column and the record both call it that. The
  // console called it `content`, so every read was undefined and the whole
  // Prompts tab threw while rendering and drew nothing at all.
  body: string;
  createdAt: string;
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

export type ScopeNode = { path: string; documents: number; total: number };

export type SourceListing = {
  source: string; scope: string; chunks: number; bytes: number;
  // queued, indexing, failed or indexed. A file uploaded a moment ago has no
  // chunks yet, and saying so is the point — otherwise it looks lost.
  status: string; error: string;
};

export type IndexJob = {
  id: string; source: string; scope: string; status: string;
  chunks: number; error: string; createdAt: string;
};

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
// The server assigns the id and the version — a caller picking either is how
// two writers both become version 4.
export const createPrompt = (promptName: string, body: string) =>
  call<PromptRow>("/prompts", {
    method: "POST",
    body: JSON.stringify({ id: "", promptName, version: 0, body, createdAt: "" }),
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

export const listScopes = () => call<ScopeNode[]>("/scopes");
export const listSources = (scope: string) =>
  call<SourceListing[]>(`/documents?scope=${encodeURIComponent(scope)}`);
export const uploadDocument = (source: string, scope: string, body: string, model: string) =>
  call<unknown>(`/documents?model=${encodeURIComponent(model)}`, {
    method: "POST",
    body: JSON.stringify({ source, scope, body }),
  });
export const listJobs = () => call<IndexJob[]>("/jobs");
export const deleteSource = (source: string) =>
  call<unknown>(`/documents/${encodeURIComponent(source)}`, { method: "DELETE" });

export const setAgentModel = (agentId: string, modelConfigId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/model`, {
    method: "PUT", body: JSON.stringify({ modelConfigId }),
  });
export const setAgentPrompt = (agentId: string, promptId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/prompt`, {
    method: "PUT", body: JSON.stringify({ promptId }),
  });
// Only the row's own columns. GET /agents answers the *full* view — prompt,
// config, servers and sub-agents nested — and spreading that back into a PUT
// sends fields the record does not declare, which JSON.parse<AgentRow>
// rejects outright.
export const updateAgent = (a: AgentRow) =>
  call<AgentRow>(`/agents/${encodeURIComponent(a.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      id: a.id, agentName: a.agentName, description: a.description,
      modelConfigId: a.modelConfigId, promptId: a.promptId,
      enabled: a.enabled, updatedAt: "now",
    }),
  });
export const createAgent = (a: AgentRow) =>
  call<AgentRow>("/agents", {
    method: "POST",
    body: JSON.stringify({
      id: a.id, agentName: a.agentName, description: a.description ?? "",
      modelConfigId: a.modelConfigId, promptId: a.promptId,
      enabled: a.enabled, updatedAt: "now",
    }),
  });

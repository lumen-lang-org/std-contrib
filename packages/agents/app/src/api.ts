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
  // The agent a new conversation opens against. Exactly one.
  isDefault: boolean;
};

export type ModelRow = {
  id: string;
  label: string;
  apiName: string;
  provider: string;
  kind: string;
  dimensions: number;
  // Empty means the provider's own address; anything else is an
  // OpenAI-compatible host — a gateway, a proxy, a local server.
  baseUrl: string;
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

export type AgentFull = AgentRow & {
  // GET /agents answers the full view: the prompt and config resolved, and
  // the links an agent has. Editing sends only the flat columns back.
  prompt: PromptRow | null;
  config: ModelConfigRow | null;
  servers: ServerRow[];
  subAgents: { id: string; agentName: string; enabled: boolean }[];
};

export type Retrieval = {
  agentId: string;
  embeddingModelId: string;
  topK: number;
  maxDistance: number;
  enabled: boolean;
};

export type ServerRow = {
  id: string;
  serverName: string;
  transport: string;
  endpoint: string;
  // "none", "bearer" or "header" — the token itself is never returned.
  authKind: string;
  authHeader: string;
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

export const listAgents = () => call<AgentFull[]>("/agents");
export const readAgent = (id: string) => call<AgentFull>(`/agents/${encodeURIComponent(id)}`);

// --- what an agent is wired to --------------------------------------------------------

export const linkServer = (agentId: string, serverId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/servers`, {
    method: "POST", body: JSON.stringify({ serverId }),
  });
export const unlinkServer = (agentId: string, serverId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/servers/${encodeURIComponent(serverId)}`,
    { method: "DELETE" });

export const linkChild = (agentId: string, childId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/sub-agents`, {
    method: "POST", body: JSON.stringify({ childId }),
  });
export const unlinkChild = (agentId: string, childId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/sub-agents/${encodeURIComponent(childId)}`,
    { method: "DELETE" });

export const agentScopes = (agentId: string) =>
  call<string[]>(`/agents/${encodeURIComponent(agentId)}/scopes`);
export const grantScope = (agentId: string, scope: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/scopes`, {
    method: "POST", body: JSON.stringify({ scope }),
  });
export const revokeScope = (agentId: string, scope: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/scopes/${encodeURIComponent(scope)}`,
    { method: "DELETE" });

export const setRetrieval = (agentId: string, r: Omit<Retrieval, "agentId">) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/retrieval`, {
    method: "PUT", body: JSON.stringify(r),
  });

export const deleteAgent = (id: string) =>
  call<unknown>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
export const deleteModel = (id: string) =>
  call<unknown>(`/models/${encodeURIComponent(id)}`, { method: "DELETE" });
export const deleteServer = (id: string) =>
  call<unknown>(`/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const updateServer = (r: ServerRow) =>
  call<ServerRow>(`/servers/${encodeURIComponent(r.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      id: r.id, serverName: r.serverName, transport: r.transport,
      endpoint: r.endpoint, authKind: r.authKind, authHeader: r.authHeader,
      enabled: r.enabled,
    }),
  });

// The token never becomes a column: it goes to the encrypted store under the
// server's id, which is why this is its own call and not a field of the row.
export const setServerAuth = (id: string, authKind: string, authHeader: string, token: string) =>
  call<unknown>(`/servers/${encodeURIComponent(id)}/auth`, {
    method: "PUT", body: JSON.stringify({ authKind, authHeader, token }),
  });
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
// A row is edited by sending the row. The rules that must hold — one enabled
// embedding model, one default agent — live in the row's PUT, so they hold
// however the row is written.
export const updateModel = (m: ModelRow) =>
  call<ModelRow>(`/models/${encodeURIComponent(m.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      id: m.id, label: m.label, apiName: m.apiName, provider: m.provider,
      kind: m.kind, dimensions: m.dimensions, baseUrl: m.baseUrl, enabled: m.enabled,
    }),
  });

export const testModel = (id: string) =>
  call<{ ok: boolean; error?: string; reply?: string; dimensions?: number; declared?: number }>(
    `/models/${encodeURIComponent(id)}/test`, { method: "POST" });

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
      enabled: a.enabled, isDefault: a.isDefault, updatedAt: "now",
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

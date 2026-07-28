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

// One artifact save, as a message refers to it. The server strips its own
// reference nonce before the wire, so what arrives is only the resolved
// address: which slot, which version, and the path the caption names. No
// previewToken here by design — a capability does not ride every message.
export type WireRef = { slot: number; version: number; path: string };

// `refs` is the only thing a card may be built from. The text's "[saved …]"
// captions are prose for the reader; mapping cards by text order was breakable
// by one forged line, so the ids travel beside the text, not inside it.
export type TranscriptTurn = { role: string; seq: number; text: string; refs: WireRef[] };

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

// What a conversation produced. A workspace file is state the agent rewrites
// as it works; an artifact is a result, addressed by a path, with every
// version it ever had still readable.
//
// Addressed by `slot`, not by path: the slot is the number a tab keeps while a
// title is edited, and a path is a second thing to escape into a URL.
export type ArtifactListing = {
  slot: number;
  path: string;
  title: string;
  // One of html, svg, markdown, json, code, text — derived from the extension
  // by the server, never sent by a caller.
  kind: string;
  mime: string;
  // The newest version number. Versions are append-only and numbered from 1,
  // so this is also how many there are — there is no route that lists them.
  version: number;
  // The unguessable half of a preview URL. Survives saving, so a link handed
  // to a reader keeps working; `rotateArtifact` is the only way to retire one.
  previewToken: string;
  createdAt: string;
  updatedAt: string;
};

// One version, body included. JSON on this origin whatever the artifact's own
// type is — rendering it as itself is the preview host's job.
export type ArtifactVersion = {
  slot: number;
  path: string;
  version: number;
  bytes: number;
  // "uploaded" (a person, through this console) or "generated" (the model's
  // tool). The only thing in a version row that answers "who wrote this".
  origin: string;
  turnSeq: number;
  note: string;
  createdAt: string;
  content: string;
};

export type ArtifactWritten = {
  slot: number; path: string; version: number; previewToken: string;
};

export type SayReply = {
  runId: string;
  ok: boolean;
  text: string;
  // The saves this turn made, already resolved to slot@version. The turn's
  // stored sequence number rides along so a caller can ask the by-turn join
  // about exactly this round; -1 when nothing was stored.
  refs: WireRef[];
  seq: number;
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

// --- artifacts ------------------------------------------------------------------------

export const listArtifacts = (threadId: string) =>
  call<ArtifactListing[]>(`/threads/${encodeURIComponent(threadId)}/artifacts`);

// One row per version a model round produced — the join a chat renders its
// cards from. Console uploads never appear: no round made them. Like a
// transcript ref this carries no previewToken; a card that needs the token
// buys it from the listing at click time.
export type TurnArtifactRef = {
  turnSeq: number; slot: number; path: string; title: string; kind: string; version: number;
};

// The whole conversation in one query rather than `?turn=N` per message: the
// client resolves refs by slot@version, and that key is unique thread-wide,
// so narrowing by turn would only multiply requests.
export const artifactsByTurn = (threadId: string) =>
  call<TurnArtifactRef[]>(`/threads/${encodeURIComponent(threadId)}/artifacts/by-turn`);

// The server files this as origin "uploaded" whatever we say: this route is a
// person with a console, and the model's writes arrive through its own tool.
// Writing a path that already exists appends a version, it does not make a
// second artifact — which is why the reply carries the number, so a caller
// knows which of two concurrent saves it won.
export const createArtifact = (
  threadId: string,
  a: { path: string; title: string; content: string; note: string },
) =>
  call<ArtifactWritten>(`/threads/${encodeURIComponent(threadId)}/artifacts`, {
    method: "POST",
    body: JSON.stringify({ path: a.path, title: a.title, content: a.content, note: a.note }),
  });

// A specific number, never "the latest". The listing already says which number
// that is, and asking for it by name would let the body a panel renders and
// the version it labels come from two different writes.
export const readArtifactVersion = (threadId: string, slot: number, version: number) =>
  call<ArtifactVersion>(
    `/threads/${encodeURIComponent(threadId)}/artifacts/${slot}/versions/${version}`);

// Mint a new preview token, so every link shared so far stops resolving. The
// token deliberately survives saving, which leaves this as the only way to
// take one back after it reaches somebody it was not meant for.
export const rotateArtifact = (threadId: string, slot: number) =>
  call<{ slot: number; previewToken: string }>(
    `/threads/${encodeURIComponent(threadId)}/artifacts/${slot}/rotate`, { method: "POST" });

// The artifact and every version it ever had. There is no undo.
export const deleteArtifact = (threadId: string, slot: number) =>
  call<unknown>(`/threads/${encodeURIComponent(threadId)}/artifacts/${slot}`,
    { method: "DELETE" });

// Where a preview is served from.
//
// Same origin by default, which means through the /api proxy — and on this
// origin the server's Host check does not match AGENTS_PREVIEW_HOST, so the
// body comes back text/plain and inert. That is the safe default and not an
// oversight: a deployment that has not been told where artifacts are isolated
// does not have anywhere to isolate them.
//
// A deployment that has one says so in index.html, and the same links start
// rendering as themselves — on a host that holds no session worth stealing.
// It is a meta tag rather than a build-time constant because the answer
// belongs to the deployment, and the built bundle is the same everywhere.
function previewOrigin(): string {
  const tag = document.querySelector('meta[name="agents-preview-origin"]');
  return (tag?.getAttribute("content") ?? "").replace(/\/+$/, "");
}

// A link to one version of an artifact.
//
// Always pinned to a version, never the bare token: the bare one follows the
// artifact, so a panel showing "version 2" beside a frame that had silently
// moved to 3 would be telling the reader something untrue. Pinned bodies are
// also immutable, which is what lets the browser cache them.
//
// The version rides in the query string rather than in the path because the
// path under the token now belongs to the artifact's siblings — the other
// artifacts of the same thread, addressed by their own path. `/preview/:token/
// v/3` could not be told apart from a sibling whose path happens to start
// `/v/`, and resolving that ambiguity needs a best-match router this one
// deliberately is not.
//
// The trailing slash is load-bearing for the same reason, and is why this
// builder emits it rather than leaving it to whoever writes a link. A document
// served at `/preview/TOKEN` resolves its own `css/main.css` against
// `/preview/` — a token named "css", i.e. nobody's artifact. Served at
// `/preview/TOKEN/` the same href resolves to `/preview/TOKEN/css/main.css`,
// which is the sibling route and the artifact the author meant.
export function previewUrl(previewToken: string, version: number): string {
  const origin = previewOrigin();
  const root = origin === "" ? BASE : origin;
  return `${root}/preview/${encodeURIComponent(previewToken)}/?v=${version}`;
}

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
// There is no PUT: a config is created and repointed, never edited, because an
// agent mid-conversation reads it every round. The API refuses to delete one an
// agent still names.
export const deleteConfig = (id: string) =>
  call<unknown>(`/model-configs/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listPrompts = () => call<PromptRow[]>("/prompts");
// The server assigns the id and the version — a caller picking either is how
// two writers both become version 4.
export const createPrompt = (promptName: string, body: string) =>
  call<PromptRow>("/prompts", {
    method: "POST",
    body: JSON.stringify({ id: "", promptName, version: 0, body, createdAt: "" }),
  });

export const listServers = () => call<ServerRow[]>("/servers");

// What a server offers, asked of the server itself — so it can fail, and the
// reason matters. A server that is unreachable and one that genuinely has no
// tools look identical on a graph and mean opposite things.
export type ServerTools = {
  serverId: string;
  problem: string;
  tools: { name: string; description: string }[];
};
export const serverTools = (id: string) =>
  call<ServerTools>(`/servers/${encodeURIComponent(id)}/tools`);
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

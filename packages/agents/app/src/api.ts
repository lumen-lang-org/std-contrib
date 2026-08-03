// The agents API, as typed calls. Everything goes through /api, which
// server/api-proxy.ts forwards to the Lumen server — the same proxy in
// development and in the image, so there is one origin everywhere and CORS
// never comes up.

export type AgentRow = {
  id: string;
  agentName: string;
  description: string;
  modelConfigId: string;
  promptId: string;
  enabled: boolean;
  // The agent a new conversation opens against. Exactly one.
  isDefault: boolean;
  // Which curated image this agent's script containers are built from. "" is
  // the deployment default. An id, never an image reference: the operator
  // curates the list, so nothing the model says can name what gets pulled.
  scriptImageId: string;
};

// An image an operator is willing to run scripts in.
export type ScriptImageRow = {
  id: string;
  label: string;
  image: string;
  enabled: boolean;
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
  // How hard to think before answering, when the provider can be told: a token
  // budget for Anthropic, an effort — low, medium, high — for the reasoning
  // models. "" is "as it normally would". This is what makes Instant and
  // Thinking two menu rows over one model.
  thinking: string;
  // What this row is called where a person picks it. `models.label` cannot
  // serve: two configs routinely share one model at different budgets and
  // would arrive in a list as the same word twice.
  label: string;
  // Whether the operator is willing to offer this config at all — not the menu
  // itself, which is model_choices, but the flag on the row.
  selectable: boolean;
  rank: number;
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

export type TemplateRow = {
  id: string;
  visibility?: string;
  label: string;
  description: string;
  // Which capability page shows it: doc, sheet, deck, page.
  kind: string;
  // The skill the page pins when a conversation starts from this template.
  skillName: string;
  featuredRank: number;
};

export const featuredSkills = () => call<SkillRow[]>("/skills?featured=1");
export const listTemplates = () => call<TemplateRow[]>("/templates");
export const saveTemplate = (t: TemplateRow) =>
  call<TemplateRow>(t.id === "" ? "/templates" : `/templates/${encodeURIComponent(t.id)}`, {
    method: t.id === "" ? "POST" : "PUT",
    body: JSON.stringify(t.id === "" ? { ...t, id: `tpl-${Date.now()}` } : t),
  });
export const deleteTemplate = (id: string) =>
  call<void>(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
export const listTemplateFiles = (id: string) =>
  call<{ id: string; templateId: string; path: string; title: string; body: string }[]>(
    `/templates/${encodeURIComponent(id)}/files`);
export const templatesOfKind = (kind: string) =>
  call<TemplateRow[]>(`/templates?kind=${encodeURIComponent(kind)}`);
// The template's document as a PDF, base64 — the picker draws its first page
// as the card's thumbnail. Answered from the engine's conversion cache after
// the first ask, so the network cost is one JSON body, not a LibreOffice run.
export const templatePdf = (id: string) =>
  call<{ template: string; path: string; cached: boolean; pdf: string }>(
    `/templates/${encodeURIComponent(id)}/pdf`);
// --- conversations offered as starting points ---------------------------------

/** Offer this conversation to other people, or stop offering it. */
export const offerThread = (id: string, on: boolean) =>
  call<{ id: string; replayable: boolean }>(
    `/threads/${encodeURIComponent(id)}/replayable`,
    { method: "PUT", body: JSON.stringify({ replayable: on }) });

/** Everything on offer, whoever owns it. */
export const replayableThreads = () => call<ThreadListing[]>("/threads/replayable");

/** Start a conversation of your own from an offered one. Answers the new
 *  thread's id and how many files came across. */
export const remixThread = (id: string) =>
  call<{ id: string; files: number }>(
    `/threads/${encodeURIComponent(id)}/remix`, { method: "POST" });

export const startFromTemplate = (threadId: string, templateId: string) =>
  call<{ template: string; skillName: string; wrote: string[]; refused: string[] }>(
    `/threads/${encodeURIComponent(threadId)}/artifacts/from-template`,
    { method: "POST", body: JSON.stringify({ templateId }) });

export type SkillRow = {
  id: string;
  skillName: string;
  description: string;
  // Not optional, and that is the whole point of the two lines. The engine's
  // SkillRow requires both, so a create that omits them is refused with
  // "invalid JSON (MissingField)" — which is exactly what the New skill button
  // was sending, so no skill could be made from the console at all. Optional
  // here meant the compiler had nothing to say about it and the e2e suite was
  // the only thing left that could notice.
  visibility: string;
  featuredRank: number;
  // Where it came from, and required for the same reason the two above are:
  // the engine's SkillRow has them, so a create that leaves them out is
  // refused with "invalid JSON (MissingField)". 'local' is a skill written
  // here and editable here; 'repo' is a copy of one a repository owns, and the
  // engine refuses a PUT to it — the console greys the edit rather than
  // letting someone type into a form whose save cannot succeed.
  source: string;
  sourceUrl: string;
  // Mutable, unlike a prompt: a skill is looked up by name at call time, so
  // an edit is live on the next use_skill with no version to point at.
  body: string;
  updatedAt: string;
};

export type SkillFileRow = {
  id: string;
  skillId: string;
  // A plain name (enums.py); it lands at /skills/<skill-name>/<path> in the
  // conversation's container on every run.
  path: string;
  body: string;
};

export type AgentFull = AgentRow & {
  // GET /agents answers the full view: the prompt and config resolved, and
  // the links an agent has. Editing sends only the flat columns back.
  prompt: PromptRow | null;
  config: ModelConfigRow | null;
  servers: ServerRow[];
  subAgents: { id: string; agentName: string; enabled: boolean }[];
  // Name and description only — a body rides GET /skills/:id.
  skills: { id: string; skillName: string; description: string }[];
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
  replayable: boolean;
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

// One row of the composer's model menu.
//
// `configId` and `routerId` are deliberately absent from the wire, and so are
// `enabled` and `rank` — the engine says why at `choicesJson` in api.ts. What
// a client may name is a choice id; everything needed to draw the row is here
// and nothing else is.
export type ModelChoice = {
  id: string;
  label: string;
  description: string;
  // "config" or "router". A router decides per message which model answers, so
  // the menu marks it rather than presenting it as one more fixed model.
  kind: string;
  // "" or "premium". A label, never a gate: the menu draws the mark and the
  // messages POST is the only place a premium row is ever refused
  // (MODEL-CHOICE.md, "Premium is a label on a choice, not a mechanism").
  tier: string;
};

// The menu, enabled rows only and already in the operator's rank order.
export const modelChoices = () => call<ModelChoice[]>("/models/choices");

export type SayReply = {
  runId: string;
  ok: boolean;
  text: string;
  // The saves this turn made, already resolved to slot@version. The turn's
  // stored sequence number rides along so a caller can ask the by-turn join
  // about exactly this round; -1 when nothing was stored.
  refs: WireRef[];
  seq: number;
  // Which menu row this turn actually ran under, "" for the agent's own — the
  // decision as it was made rather than as it was asked for. Not fed back into
  // the picker: the picker says what the NEXT send will carry, and by the time
  // an answer lands the person may already have changed it. It is here because
  // the wire carries it and a field nobody can see is a field that gets
  // reinvented.
  modelChoiceId: string;
  // Why the model that answered was the one that did — a router's pick, or a
  // fallback after one failed. "" when there is nothing to explain. This is
  // what the round card's "routed → Thinking" row is drawn from when the
  // router lands.
  routeNote: string;
  toolCalls: number;
  // The calls this round dispatched, arriving with the answer rather than
  // through a second request. The poll is for watching a round that is still
  // running; this is the round that is over, and they must agree.
  steps: LiveStep[];
  thoughts: Thought[];
  inputTokens: number;
  outputTokens: number;
  traceId: string;
  error: string;
  // For a guest caller only: how many free messages remain today, re-counted
  // server-side after this run was recorded. Absent for everyone signed in —
  // the strip that reads it is only drawn for guests, and a number that is
  // sometimes missing is better than a 0 that means "unlimited" here and
  // "spent" there.
  guestRemaining?: number;
};

const BASE = "/api";

// What a refused request raises. The console answers 401 with an overlay of
// its own (src/login-overlay.ts) rather than a navigation: leaving the page
// meant the gateway had to serve another application's whole single-page
// build under this hostname, and that proxying — its entry chunk, the modules
// that chunk imports, its stylesheets, its loader routes — was the cause of
// three separate outages in one day, none of them about signing in.
//
// An event, not a direct render, because `call` is used from every component
// and must not know which one is holding the shell.
export const SIGNED_OUT = "agents:signed-out";

// Raised when the engine refuses a send with the guest quota's 429 — the
// body says `error: "guest_quota"`, which is the only 429 the console treats
// as anything but a generic error. Same shape as SIGNED_OUT and for the same
// reason: `call` cannot know which component holds the shell. Deliberately
// NOT latched the way SIGNED_OUT is: a guest who dismisses the overlay and
// tries again meets the wall again, and that second event is the truth.
// detail: { resetsAt: string; limit: number; used: number }.
export const QUOTA_SPENT = "agents:quota-spent";

// A 401 is not an error to render — it means nobody is signed in, and the only
// useful response is to go and sign in. Without this the console drew an empty
// conversation list to a logged-out visitor: the product, apparently working,
// apparently containing nothing. `returnTo` is a path, never a full URL, so a
// crafted link cannot use this to bounce anyone off-site.
let announced = false;
// Set once /whoami has answered, so a 401 can be read in the light of who is
// asking. A guest is signed in as far as the front door is concerned; a 401
// for them means "this route needs an account", which is a fact about the
// route and not about their session.
let callerIsGuest = false;
export function noteGuestCaller(anonymous: boolean): void { callerIsGuest = anonymous; }

function toLogin(): void {
  // A guest is never bounced to the login by a background call. Every
  // guest-closed route (the operator's model list, the admin surfaces, the
  // socket) answers 401 to them by design, and treating that as a lost session
  // put the login overlay over a console that was working — the first paint
  // this whole feature exists to avoid. The soft wall on a spent quota, and a
  // gated action a person actually clicked, are the two ways in from here.
  if (callerIsGuest) { return; }
  // Once per page: several calls fail together on a cold load, and the shell
  // needs one signal, not one per request in flight.
  if (announced) { return; }
  announced = true;
  window.dispatchEvent(new CustomEvent(SIGNED_OUT));
}

// The signed-in caller, as the front door describes them. Shaped by the
// gateway's X-USER, so it is the same identity the engine is handed.
export type Me = {
  uuid: string;
  username: string;
  email: string;
  roles: string[];
  // True when the gateway minted this caller a guest identity rather than
  // verifying a login. A guest is a real 200 from /whoami — NOT a 401, so the
  // login overlay never rises on first paint — and holds no roles, so every
  // admin gate already answers no. Optional because two of the three
  // deployments (community, builtin) never say it at all.
  anonymous?: boolean;
};

// `null` means no front door — a community deployment, where there is no auth
// at all and the operator is whoever reached the box. That is NOT the same as
// a signed-in user holding no roles, and the two must not collapse: the first
// should see every tool, the second should see none of the admin ones.
// The identity the server already injected, if it did.
//
// LumenJS writes `req.nkAuth.user` into a `__nk_auth__` script tag and hydrates
// `@lumenjs/auth`'s store from it before the first render — so in a deployment
// that establishes identity server-side (all three of ours do, see
// pages/_middleware.ts) the answer is on the page already and asking for it
// over the network is a round trip that can only arrive late. Late is the whole
// problem: the rail draws before it lands, and a `null` there means "community,
// show everything".
//
// Read straight from the script tag rather than importing `@lumenjs/auth`: that
// specifier is a dev-server alias onto the framework's runtime directory, not
// something the package exports, so importing it works in dev and disappears in
// a build. The tag is the contract either way.
function injectedUser(): Me | null {
  if (typeof document === "undefined") { return null; }
  const tag = document.getElementById("__nk_auth__");
  if (tag === null) { return null; }
  try {
    const u = JSON.parse(tag.textContent ?? "") as Partial<Me> & { sub?: string };
    return {
      // The framework's shape calls it `sub`; the gateway's calls it `uuid`.
      uuid: u.uuid ?? u.sub ?? "",
      username: u.username ?? u.email ?? "",
      email: u.email ?? "",
      roles: Array.isArray(u.roles) ? u.roles : [],
      // Carried through, never defaulted to false: `undefined` is what the
      // deployments that have no guests say, and it must stay distinguishable.
      ...(u.anonymous === true ? { anonymous: true } : {}),
    };
  } catch { return null; }
}

export async function whoami(): Promise<Me | null> {
  const injected = injectedUser();
  if (injected !== null) { return injected; }

  // Not through `call`: /whoami is the gateway's own route, not the engine's,
  // so it does not live under the /api prefix.
  const res = await fetch("/whoami", { headers: { accept: "application/json" } });
  // 401 and "no such route" are opposite answers and must not collapse into
  // one. A 401 means a front door exists and nobody is signed in — the caller
  // is anonymous, holds no roles, and belongs at the login. Anything else that
  // fails to answer means there is no front door at all, which is the
  // community edition, where the operator is whoever reached the box and every
  // tool is theirs. Returning `null` for both handed a logged-out visitor the
  // community's answer, and `isAdmin(null)` is `true` — so the admin menu was
  // offered for as long as it took the data calls to redirect. A race, and it
  // was only ever won by accident.
  if (res.status === 401) {
    toLogin();
    return { uuid: "", username: "", email: "", roles: [] };
  }
  if (!res.ok) { return null; }
  const body = (await res.text()).trim();
  if (body === "" || body === "null") { return null; }
  try {
    const me = JSON.parse(body) as Me;
    // Before any caller reads it: the boot calls fan out immediately after
    // this resolves, and several of them are closed to guests.
    noteGuestCaller(me.anonymous === true);
    return { ...me, roles: Array.isArray(me.roles) ? me.roles : [] };
  } catch { return null; }
}

// The guest ration, asked once at boot and never polled: every send's reply
// carries `guestRemaining`, so this is only the number the strip first paints.
// `limit: 0` means unlimited — the signed-in answer and the community one —
// and the other members only travel when there is a ration to describe.
export type QuotaStatus = {
  limit: number;
  used?: number;
  remaining?: number;
  resetsAt?: string;
};

export const getQuota = () => call<QuotaStatus>("/quota");

export const isAdmin = (me: Me | null): boolean =>
  me === null ? true : me.roles.includes("admin");

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.text();
  if (res.status === 401) {
    toLogin();
    // The redirect is not instant, and every caller still awaits this. Throwing
    // keeps a half-authenticated render from happening in the meantime.
    throw new Error("not signed in");
  }
  // The guest quota's refusal, and only that one: any other 429 falls through
  // to the generic path below. No redirect and no overlay from here — the
  // event is the announcement, and the shell decides what stands in front of
  // the conversation. The thrown sentence is what lands in the transcript, so
  // it is written for a person, not a log.
  if (res.status === 429) {
    type QuotaBody = { error?: string; resetsAt?: string; limit?: number; used?: number };
    let said: QuotaBody | null = null;
    try { said = JSON.parse(body) as QuotaBody; } catch { /* not JSON */ }
    if (said?.error === "guest_quota") {
      window.dispatchEvent(new CustomEvent(QUOTA_SPENT, {
        detail: {
          resetsAt: said.resetsAt ?? "",
          limit: said.limit ?? 10,
          used: said.used ?? said.limit ?? 10,
        },
      }));
      throw new Error("You have used your free messages for today. Sign in to keep chatting.");
    }
  }
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

export const linkSkill = (agentId: string, skillId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/skills`, {
    method: "POST", body: JSON.stringify({ skillId }),
  });
export const unlinkSkill = (agentId: string, skillId: string) =>
  call<unknown>(`/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
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
export const listScriptImages = () => call<ScriptImageRow[]>("/script-images");
export const createScriptImage = (row: ScriptImageRow) =>
  call<ScriptImageRow>("/script-images", { method: "POST", body: JSON.stringify(row) });
export const updateScriptImage = (row: ScriptImageRow) =>
  call<ScriptImageRow>(`/script-images/${encodeURIComponent(row.id)}`,
    { method: "PUT", body: JSON.stringify(row) });
export const deleteScriptImage = (id: string) =>
  call<unknown>(`/script-images/${encodeURIComponent(id)}`, { method: "DELETE" });

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
// A conversation, as a person reads it, plus the one fact about the thread
// that is not about any one message in it.
//
// An object where this used to be a bare array of turns, and the engine's own
// note on the route says why: the conversation's current model choice belongs
// to the thread, and an array has nowhere to put it. The alternatives were a
// second round trip for a single field or a response header, and a header is
// where facts go to be forgotten. Without it, reopening a conversation would
// show the picker set to whatever the composer happened to be showing rather
// than to what that conversation last chose — and the column exists for
// exactly that memory.
export type Transcript = {
  modelChoiceId: string;
  messages: TranscriptTurn[];
  /** Whether this conversation is the caller's. False for one somebody
   *  else offered as a starting point — readable, never writable. */
  mine?: boolean;
};

export const transcript = (id: string) =>
  call<Transcript>(`/threads/${encodeURIComponent(id)}`);
// One dispatched call, as the API reports it while the round is still running.
// `running` is the whole liveness signal; `millis` is -1 until it stops.
export type LiveStep = {
  seq: number;
  // Which rotation of the model loop dispatched it. One message is not one
  // exchange: the model calls tools, reads the results, and may call more
  // before it answers, and each rotation asked for its own set.
  rotation: number;
  // How far down the delegation it was made: 0 is the agent you are talking to,
  // 1 is a sub-agent it asked. The card indents by this, so a child's tools sit
  // under the delegation that caused them.
  depth: number;
  idx: number;
  // "tool" for anything dispatched by name, "agent" for a delegation.
  kind: string;
  name: string;
  target: string;
  args: string;
  running: boolean;
  ok: boolean;
  millis: number;
  // What the call answered, capped server-side. Empty while running and for
  // rows written before the column existed.
  result: string;
};

// What the model said it was thinking on one rotation, when it says at all.
// Most providers never do, and a round with none is the ordinary case.
// `seq` is the round it belongs to, for the same reason a step carries one: a
// reload asks for every round at once and has to put each thought back above
// the message that produced it.
export type Thought = { seq: number; rotation: number; depth: number; text: string };

export type RoundSteps = {
  seq: number; running: boolean; steps: LiveStep[]; thoughts: Thought[];
};

// What the run is doing right now. Polled while POST /messages is outstanding —
// that request answers once, at the end, so this is the only way to see inside
// a round. `seq=all` is the whole transcript, for a console that has reloaded
// and needs a card above every message that called something.
export const threadSteps = (threadId: string, seq?: number | "all") =>
  call<RoundSteps>(`/threads/${encodeURIComponent(threadId)}/steps`
    + (seq === undefined ? "" : `?seq=${seq}`));

// A message, carrying the composer's model choice with it.
//
// This is the whole of the picker's contract with the engine — one optional
// field on the send. There is no endpoint for "set the model on this thread"
// and there must not be one: the picker is used BEFORE the thread exists on a
// new conversation, and a control that fired its own request would need a
// thread to fire it at. The engine applies the choice to this turn and
// remembers it on the thread, so the next send with no field still runs on it.
//
// "" is not a third state. It is already what "nothing chosen" means on the
// thread row and in the resolver, so a caller that omits the field and one
// that sends "" both get the agent's own model.
//
// POST /threads accepts the same field and the console does not use it:
// `ensureThread` is also the door a file upload and a template start knock on,
// and a stale menu answering 400 there would fail an attachment that has
// nothing to do with which model answers. The first message's POST sets the
// thread's choice a moment later anyway.
export const say = (id: string, text: string, modelChoiceId = "", think = false) =>
  call<SayReply>(`/threads/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    // `think` travels with the message, like the picker beside it: what the
    // composer shows is what the next send carries, and an earlier answer is
    // never re-thought because a later one asked to be.
    body: JSON.stringify({ text, modelChoiceId, think }),
  });

export const readBanner = () => call<{ text: string }>("/banner");
export const writeBanner = (text: string) =>
  call<{ text: string }>("/banner", { method: "PUT", body: JSON.stringify({ text }) });

/* Ask the running turn to stop. 200 means heard, not stopped: the turn ends
   at its next boundary and the in-flight messages POST reports how. */
export const cancelTurn = (threadId: string) =>
  call<{ asked: boolean }>(`/threads/${encodeURIComponent(threadId)}/cancel`, { method: "POST" });

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

// One office document as a PDF, converted by the platform.
//
// `pdf` is base64, because binary cannot ride the engine's JSON — the same
// boundary an office artifact's own body already crosses. `cached` says
// whether a container ran for this call, which is only worth knowing when
// something is slow.
export type OfficePdf = {
  slot: number; path: string; version: number; cached: boolean; pdf: string;
};

// A version is immutable, so this answer is too: the conversion behind it is
// cached forever on the server and never has to be asked for twice for the
// same slot@version. Always pin the version rather than letting the server
// pick the current one — the panel already knows which version it is showing,
// and an unpinned request would race a save.
export const officePdf = (threadId: string, slot: number, version: number) =>
  call<OfficePdf>(
    `/threads/${encodeURIComponent(threadId)}/artifacts/${slot}/pdf?v=${version}`);

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
// A person's file, read the way the store keeps it: text kinds as the text
// itself, everything else as base64 — one rule shared by the panel's upload
// button and the composer's attach, so a .xml lands identically from either.
const TEXTUAL_UPLOAD = /\.(html?|svg|md|markdown|json|css|js|mjs|ts|tsx|jsx|py|sql|sh|yaml|yml|toml|txt|csv|log)$/i;

export async function uploadFileArtifact(threadId: string, file: File): Promise<ArtifactWritten> {
  const name = file.name.replace(/[^A-Za-z0-9.-]+/g, "-");
  const content = TEXTUAL_UPLOAD.test(name)
    ? await file.text()
    : await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",", 2)[1] ?? "");
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
  return createArtifact(threadId, { path: "/" + name, title: file.name, content, note: "uploaded from the console" });
}

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
// Every column, because a create is parsed as a whole record on the engine
// side and a member the record declares but the body omits is a refused
// request, not a default — the same trap `updateAgent` records below.
export const createConfig = (row: ModelConfigRow) =>
  call<ModelConfigRow>("/model-configs", { method: "POST", body: JSON.stringify(configBody(row)) });

// A config IS edited now, and only in the fields below.
//
// The PUT is a merge — a member the body leaves out is left alone — so this
// sends the row's own columns and nothing else. It deliberately does not send
// back what the GET answered: `GET /model-configs` nests the whole `model`
// object inside each row (a hasOne relation), and echoing that back would be a
// document the engine's record type cannot parse.
export const updateConfig = (row: ModelConfigRow) =>
  call<ModelConfigRow>(`/model-configs/${encodeURIComponent(row.id)}`, {
    method: "PUT", body: JSON.stringify(configBody(row)),
  });

const configBody = (c: ModelConfigRow) => ({
  id: c.id, modelId: c.modelId, temperature: c.temperature, maxTokens: c.maxTokens,
  topP: c.topP, extra: c.extra, thinking: c.thinking ?? "", label: c.label ?? "",
  selectable: c.selectable ?? false, rank: c.rank ?? 0,
});

export const deleteConfig = (id: string) =>
  call<unknown>(`/model-configs/${encodeURIComponent(id)}`, { method: "DELETE" });

// --- the menu, as the operator sees it ------------------------------------------------
//
// `GET /model-choices` is not `GET /models/choices`. That one is the user's
// menu: enabled rows only, and neither id on the wire. This one is every row
// with both ids, because an operator who cannot see the disabled rows cannot
// re-enable them and one who cannot see `configId` cannot tell two rows called
// "Fast" apart.
export type ModelChoiceRow = {
  id: string;
  label: string;
  description: string;
  // "config" or "router". Which one says which of the two ids below is live —
  // stated rather than inferred, so a row with both set is a mistake the engine
  // shows rather than a precedence rule.
  kind: string;
  configId: string;
  routerId: string;
  // "" or "premium". A label, never a gate.
  tier: string;
  enabled: boolean;
  // Where it sits in the menu. The column is `menu_rank` and the wire calls it
  // `rank`; the engine's PUT accepts either and reads `rank` first, so a row
  // read and written back is lossless.
  rank: number;
};

export const listModelChoices = () => call<ModelChoiceRow[]>("/model-choices");
export const createModelChoice = (row: ModelChoiceRow) =>
  call<ModelChoiceRow>("/model-choices", { method: "POST", body: JSON.stringify(row) });
// Every field the form shows — and `rank`, which it does not, is deliberately
// absent.
//
// The engine merges member by member, so an omitted member is left alone. The
// form has no rank control: order is the arrows in the list, which write the
// rank alone. Sending the rank back from a form would mean opening an entry,
// leaving it a while, and saving a label put the menu back in the order it was
// in when the form was opened — undoing somebody else's reorder, and one's own,
// with a button that says nothing about order.
export const updateModelChoice = (row: ModelChoiceRow) =>
  call<ModelChoiceRow>(`/model-choices/${encodeURIComponent(row.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      id: row.id, label: row.label, description: row.description, kind: row.kind,
      configId: row.configId, routerId: row.routerId, tier: row.tier, enabled: row.enabled,
    }),
  });
// Reordering sends the rank alone. A move is one field, and a full-row PUT per
// row of a reorder would carry every other field back over rows the operator
// did not open — including any edit somebody else made between the read and
// the drag.
export const rankChoice = (id: string, rank: number) =>
  call<ModelChoiceRow>(`/model-choices/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({ id, rank }),
  });
export const deleteModelChoice = (id: string) =>
  call<unknown>(`/model-choices/${encodeURIComponent(id)}`, { method: "DELETE" });

// --- routers ---------------------------------------------------------------------------

// One candidate the routing model may choose, and the prose that tells it when.
//
// `when` is the whole interface to the decision: the routing call is given the
// keys and these lines and nothing else about what the models are.
export type RouterCandidate = {
  key: string;
  configId: string;
  when: string;
};

// `candidates` is a real array in both directions. The stored column is
// `candidatesJson` and the engine refuses a body that names it — a
// pre-encoded blob is the one structure the API could not look inside, and an
// ignored edit means the router goes on routing the way it did yesterday.
export type ModelRouterRow = {
  id: string;
  label: string;
  // The config that DOES the routing: small, fast, cheap. Its reply is matched
  // against the candidate keys, never parsed.
  routerConfigId: string;
  // Where every failure path lands — an unknown key, an empty reply, a
  // provider error. A run that would have happened must still happen.
  fallbackConfigId: string;
  // "turn" or "thread".
  routeEvery: string;
  // Whether the router may only move UP the candidate order within one
  // conversation.
  escalateOnly: boolean;
  enabled: boolean;
  candidates: RouterCandidate[];
};

export const listRouters = () => call<ModelRouterRow[]>("/model-routers");
export const createRouter = (row: ModelRouterRow) =>
  call<ModelRouterRow>("/model-routers", { method: "POST", body: JSON.stringify(row) });
export const updateRouter = (row: ModelRouterRow) =>
  call<ModelRouterRow>(`/model-routers/${encodeURIComponent(row.id)}`, {
    method: "PUT", body: JSON.stringify(row),
  });
export const deleteRouter = (id: string) =>
  call<unknown>(`/model-routers/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listSkills = () => call<SkillRow[]>("/skills");
// Skills are edited in place, unlike prompts: a skill is read fresh on every
// use_skill, so the next load sees the edit and nothing pins an old body.
export const createSkill = (row: SkillRow) =>
  call<SkillRow>("/skills", { method: "POST", body: JSON.stringify(row) });

/** Your own editable copy of a skill a repository owns. The engine picks the
 *  name (the original's, suffixed) because it is the side that can see which
 *  names are taken, and answers the row it made. */
export const copySkillLocally = (id: string) =>
  call<SkillRow>(`/skills/${encodeURIComponent(id)}/copy`, { method: "POST" });
export const updateSkill = (row: SkillRow) =>
  call<SkillRow>(`/skills/${encodeURIComponent(row.id)}`,
    { method: "PUT", body: JSON.stringify(row) });
export const deleteSkill = (id: string) =>
  call<unknown>(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
export const listSkillFiles = (skillId: string) =>
  call<SkillFileRow[]>(`/skills/${encodeURIComponent(skillId)}/files`);
export const createSkillFile = (row: SkillFileRow) =>
  call<SkillFileRow>(`/skills/${encodeURIComponent(row.skillId)}/files`,
    { method: "POST", body: JSON.stringify(row) });
export const updateSkillFile = (row: SkillFileRow) =>
  call<SkillFileRow>(`/skills/${encodeURIComponent(row.skillId)}/files/${encodeURIComponent(row.id)}`,
    { method: "PUT", body: JSON.stringify(row) });
export const deleteSkillFile = (skillId: string, fileId: string) =>
  call<unknown>(`/skills/${encodeURIComponent(skillId)}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" });

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

// Your own token for a connector — stored for the caller the gateway
// verified, never anyone else, and never readable back. `stored` is the whole
// of what can be known afterwards.
export const serverMine = (id: string) =>
  call<{ stored: boolean }>(`/servers/${encodeURIComponent(id)}/mine`);
export const setServerMine = (id: string, token: string) =>
  call<{ stored: boolean }>(`/servers/${encodeURIComponent(id)}/mine`, {
    method: "PUT", body: JSON.stringify({ token }),
  });
export const forgetServerMine = (id: string) =>
  call<unknown>(`/servers/${encodeURIComponent(id)}/mine`, { method: "DELETE" });

// --- ways of signing in --------------------------------------------------------
//
// The client id is a row; the secret is never returned — `configured` is all
// that can be known about it, the same contract a provider key and a
// connector token keep.
export type AuthProviderRow = {
  id: string;
  label: string;
  // "oidc" (issuer-discovered) or "github" (OAuth2, no issuer).
  kind: string;
  issuer: string;
  clientId: string;
  scopes: string;
  enabled: boolean;
  configured?: boolean;
};

export const listAuthProviders = () => call<AuthProviderRow[]>("/auth-providers");
export const saveAuthProvider = (row: AuthProviderRow, fresh: boolean) =>
  call<AuthProviderRow>(fresh ? "/auth-providers" : `/auth-providers/${encodeURIComponent(row.id)}`, {
    method: fresh ? "POST" : "PUT",
    body: JSON.stringify({ id: row.id, label: row.label, kind: row.kind || "oidc", issuer: row.issuer,
      clientId: row.clientId, scopes: row.scopes, enabled: row.enabled }),
  });
export const setAuthProviderSecret = (id: string, clientSecret: string) =>
  call<unknown>(`/auth-providers/${encodeURIComponent(id)}/secret`, {
    method: "PUT", body: JSON.stringify({ clientSecret }),
  });
export const deleteAuthProvider = (id: string) =>
  call<unknown>(`/auth-providers/${encodeURIComponent(id)}`, { method: "DELETE" });

// --- plugins ------------------------------------------------------------------
//
// The third noun. A skill is instructions, a connector is a service you can
// call, and a plugin is a bundle somebody else published that arrives carrying
// some of each — so the only thing typed here is where it came from.
//
// Nothing else in the console learns a new concept: an installed plugin's
// skills come back from `/skills` and its connectors from `/servers`, as
// ordinary rows. These calls are about acquiring and removing, which is the
// whole of what makes a plugin different from the two things it installs.
export type PluginRow = {
  id: string;
  pluginName: string;
  description: string;
  sourceUrl: string;
  version: string;
  installedAt: string;
};

// What a manifest would install, read without installing it. `problem` is the
// engine's answer to "would this land cleanly" — a name already taken, most
// often — and is empty when it would.
export type PluginPreview = {
  name: string;
  description: string;
  version: string;
  problem: string;
  skills: { name: string; description: string; files: number }[];
  connectors: { name: string; endpoint: string; authKind: string }[];
};

export type PluginItem = { kind: string; itemId: string; name: string };

export const listPlugins = () => call<PluginRow[]>("/plugins");
export const pluginItems = (id: string) =>
  call<PluginItem[]>(`/plugins/${encodeURIComponent(id)}/items`);
export const inspectPlugin = (sourceUrl: string) =>
  call<PluginPreview>("/plugins/inspect", {
    method: "POST", body: JSON.stringify({ sourceUrl }),
  });
export const installPlugin = (sourceUrl: string) =>
  call<PluginRow>("/plugins/install", {
    method: "POST", body: JSON.stringify({ sourceUrl }),
  });
export const removePlugin = (id: string) =>
  call<unknown>(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });

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
// The body carries every column of the row, because the server parses the
// whole record and a missing member is a refused request, not a default —
// "JSON.parse: invalid JSON (MissingField)" in the form's error line. The
// first save through this call is what found scriptImageId absent here.
export const updateAgent = (a: AgentRow) =>
  call<AgentRow>(`/agents/${encodeURIComponent(a.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      id: a.id, agentName: a.agentName, description: a.description,
      modelConfigId: a.modelConfigId, promptId: a.promptId,
      scriptImageId: a.scriptImageId ?? "",
      enabled: a.enabled, isDefault: a.isDefault, updatedAt: "now",
    }),
  });
export const createAgent = (a: AgentRow) =>
  call<AgentRow>("/agents", {
    method: "POST",
    body: JSON.stringify({
      id: a.id, agentName: a.agentName, description: a.description ?? "",
      modelConfigId: a.modelConfigId, promptId: a.promptId,
      scriptImageId: a.scriptImageId ?? "", isDefault: a.isDefault ?? false,
      enabled: a.enabled, updatedAt: "now",
    }),
  });

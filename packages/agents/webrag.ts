// The public web index, feeding a conversation.
//
// The deployment already has two kinds of grounding and this is deliberately a
// third, not a merger: knowledge.ts retrieves from documents an operator
// uploaded and embedded per agent; the search index (joule-crawl, reached at
// JOULE_SEARCH_API) is a crawled web corpus with its own ranking, snippeting
// and character budget, asked over HTTP. The index does everything inside —
// this file sends a query string and receives passages, and knows nothing
// about embeddings, tiers or scoring.
//
// Per agent, like agent_retrieval and for the same reason: the assistant
// benefits from the open web, a docflow validator does not, and one global
// switch would make that a fight. The row is absent until set, which is how an
// agent that does not read the web is spelled.
//
// The query can be the user's message verbatim, or written by a model first
// ("generated"): a designated chat model is asked to turn the message into a
// short search query. A conversational message is a bad search string —
// "well ok but what about the second one" retrieves nothing — and a model
// call is the difference. It is a designated model rather than the round's
// own so an operator can pin something fast and cheap for it while the
// conversation runs on something slower.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, field, repository, findById, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, modelsMapping } from "./schema.ts";
import { ToolSpec, complete, replyText, toolSpec } from "./provider.ts";
import { credentialFor } from "./credentials.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";
import { urlEncode } from "./mcp-oauth.ts";

export type AgentWebRagRow = {
  agentId: string,
  enabled: bool,
  // How many passages to ask the index for. The index caps at 20.
  topK: int,
  // The index's own character budget for the whole answer — it stops adding
  // passages when this is spent, so it is the size of the injected block and
  // therefore the knob that protects the model's context window.
  maxChars: int,
  // "verbatim" sends the user's message as the query; "generated" asks
  // queryModelId to write a search query from it first.
  queryMode: string,
  queryModelId: string,
};

export function agentWebRagMapping(): DbRepository {
  let fs: DbField[] = [
    field("agentId", "agent_id", "text"),
    field("enabled", "enabled", "bool"),
    field("topK", "top_k", "int"),
    field("maxChars", "max_chars", "int"),
    field("queryMode", "query_mode", "text"),
    field("queryModelId", "query_model_id", "text"),
  ];
  return repository("agent_web_rag", "agentId", "agent_id", fs);
}

export function webRagPlan(db: Db): Migration[] {
  return [
    migration("95", "which agents read the web index", createTableSql(db, agentWebRagMapping())),
  ];
}

/** The agent's web retrieval, or the row that means "none".
 *
 *  Same contract as retrievalFor: an absent row answers disabled with sane
 *  numbers, so no caller branches on existence. */
export function webRagFor(db: Db, agentId: string): AgentWebRagRow {
  let held = findById(db, agentWebRagMapping(), agentId);
  if (held == "") {
    let none: AgentWebRagRow = { agentId: agentId, enabled: false, topK: 5, maxChars: 6000, queryMode: "verbatim", queryModelId: "" };
    return none;
  }
  return JSON.parse<AgentWebRagRow>(held);
}

/** Where the index answers. The same address the console's search proxy uses,
 *  read from the same variable so the two cannot drift apart. It is a tailnet
 *  address with no auth on it, which is exactly why neither this process nor
 *  the console may ever hand it to a browser. */
export function searchApiBase(): string {
  let set = process.env("JOULE_SEARCH_API") ?? "";
  if (set != "") { return set; }
  return "http://100.110.210.29:8080";
}

export type WebPassage = {
  url: string,
  title: string,
  text: string,
};

export type WebFound = {
  ok: bool,
  query: string,
  found: WebPassage[],
  error: string,
};

/** Ask a model to turn a message into a search query.
 *
 *  Everything that can go wrong falls back to the message verbatim, and the
 *  caller cannot tell — deliberately. A query generator that is down must
 *  degrade retrieval quality, never turn retrieval off; the note the run
 *  carries says which query was actually used, which is where the difference
 *  becomes visible.
 *
 *  The answer is clipped and de-quoted because models decorate: a query comes
 *  back wrapped in quotes, or with "Search query:" in front, and every one of
 *  those characters would be searched for literally. */
export function generateQuery(db: Db, row: AgentWebRagRow, userText: string, master: string): string {
  if (row.queryMode != "generated" || row.queryModelId == "") { return userText; }
  let modelDoc = findById(db, modelsMapping(), row.queryModelId);
  if (modelDoc == "") { return userText; }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) { return userText; }
  let key = credentialFor(db, model.provider, master);
  if (key == "") { return userText; }

  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.0, maxTokens: 60, topP: 1.0,
    extra: "", thinking: "", label: "", selectable: false, rank: 0,
  };
  let asked = complete(model, config,
    "Write one short web-search query for the person's message. Answer with the query text only — "
    + "no quotes, no prefix, no explanation. Keep names, versions and error strings intact.",
    userText, key);
  if (!asked.ok) { return userText; }
  /* The MESSAGE, not the envelope.
   *
   * `Completion.text` carries the provider's whole response body, and this
   * read it as if it were the assistant's words: every generated query was a
   * few hundred characters of `{"id":"chatcmpl-…","choices":[…]}`, which the
   * length guard below then rejected — so "generated" query mode has been
   * silently falling back to the user's own text since it was written. It
   * never errored, which is why nobody saw it. */
  let q = replyText(model.provider, asked.text).trim();
  // First line only, undecorated.
  let brk = q.indexOf("\n");
  if (brk >= 0) { q = q.slice(0, brk).trim(); }
  if (q.startsWith("\"") && q.endsWith("\"") && q.length > 1) { q = q.slice(1, q.length - 1); }
  if (q == "" || q.length > 300) { return userText; }
  return q;
}

/** Passages for a query, from the index.
 *
 *  GET with the query in the URL, which is the index's own contract
 *  (joule-crawl src/server.ts): k caps at 20 there, max_chars at 100000, and
 *  the budget is spent on the index's side so what comes back is already
 *  sized. */
export function retrieveWeb(query: string, topK: int, maxChars: int): WebFound {
  let url = searchApiBase() + "/retrieve?q=" + urlEncode(query)
    + "&k=" + `${topK}` + "&max_chars=" + `${maxChars}`;
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok) {
    let dead: WebFound = { ok: false, query: query, found: [], error: "the search index did not answer" };
    return dead;
  }
  if (res.status != 200) {
    let refused: WebFound = { ok: false, query: query, found: [], error: "the search index answered " + `${res.status}` };
    return refused;
  }
  let out: WebPassage[] = [];
  let rows = jsonList(jsonRaw(res.body, "passages"));
  let i: int = 0;
  while (i < rows.length) {
    let p: WebPassage = {
      url: jsonText(rows[i], "url"),
      title: jsonText(rows[i], "title"),
      text: jsonText(rows[i], "text"),
    };
    if (p.text != "") { out.push(p); }
    i = i + 1;
  }
  let answer: WebFound = { ok: true, query: query, found: out, error: "" };
  return answer;
}

/** The retrieved web as a context block.
 *
 *  Same guard rails as knowledge.ts::asContext, and they are not decoration —
 *  the incident that shaped that wording (an agent refusing its own tools
 *  because retrieved context "did not cover" the task) applies with more
 *  force here, because the open web resembles everything a little and the
 *  question exactly never. What this block adds is the citation ask: these
 *  passages have URLs, and an answer drawn from one should say which. */
export function asWebContext(found: WebPassage[]): string {
  if (found.length == 0) { return ""; }
  let out = "Passages retrieved from the public web index for this question. "
    + "They are retrieved by resemblance to the question, so they may be beside the point: judge. "
    + "When you answer from one, cite its URL; never attribute to these pages what is not in them, "
    + "and when the task calls for your tools or skills, use them regardless of what was retrieved.\n";
  let i: int = 0;
  while (i < found.length) {
    out = out + "\n[" + found[i].title + "](" + found[i].url + ")\n" + found[i].text + "\n";
    i = i + 1;
  }
  return out;
}

/** A one-line account of what the web gave this round, for the run's notes. */
export function webSummary(query: string, found: WebPassage[]): string {
  let urls: string[] = [];
  let i: int = 0;
  while (i < found.length) { urls.push(found[i].url); i = i + 1; }
  return "web index: \"" + query + "\" -> " + `${found.length}` + " passages (" + urls.join(", ") + ")";
}


// --- the web index, as a tool the model can call ---------------------------------
//
// Retrieval above is automatic: it runs on every turn of an agent configured
// for it, whether the question needed the web or not. This is the other half —
// the model deciding, mid-answer, that it needs to look something up.
//
// It replaces a skill that drove a real browser in a container: the old
// search-web loaded Chromium and scraped DuckDuckGo, then Bing, then Brave,
// which is minutes of container start and page load, and depends on three
// sites not blocking a datacentre address. This is one HTTP call to an index
// the deployment already runs and already trusts. The script image stays where
// it is — nothing here deletes it — so a deployment that wants the browser
// path back has it.

export function webSearchTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  out.push(toolSpec("search_web",
    "Search the deployment's own web index and get back passages, not just links. "
    + "This is a crawled corpus with the pages' real text in it, so what comes back is readable evidence: "
    + "answer from the passages and cite the url you used. "
    + "Ask it what a search engine can answer — keywords and names, not a paragraph. "
    + "When nothing comes back, say the index has nothing on it rather than guessing; it is one corpus, not the whole web.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"query\":{\"type\":\"string\",\"description\":\"What to look for. Keywords, names, versions or an error string — not a sentence.\"},"
    + "\"count\":{\"type\":\"integer\",\"description\":\"How many passages to return. 1 to 20; 5 is a good default.\"}},"
    + "\"required\":[\"query\"]}"));
  return out;
}

/** Answer `search_web`, or "" when the call is not this tool's.
 *
 *  The same shape every other dispatcher in run.ts has: asked about every
 *  call, answers only its own name, so the eager ask costs one comparison. */
export function callWebSearchTool(name: string, args: string): string {
  if (name != "search_web") { return ""; }
  let query = jsonText(args, "query");
  if (query.trim() == "") {
    return "search_web needs a query: {\"query\":\"rust release notes\"}.";
  }
  let count = parseInt(jsonText(args, "count"), 10) ?? 5;
  if (count <= 0 || count > 20) { count = 5; }
  // A character budget rather than a passage count alone: the index spends it
  // and stops, so a call cannot return more context than a reply can hold.
  let found = retrieveWeb(query, count, 6000);
  if (!found.ok) { return "The search index did not answer: " + found.error; }
  if (found.found.length == 0) {
    return "Nothing in the index for \"" + query + "\". It is one crawled corpus, not the whole web — say so rather than guessing.";
  }
  let out = "";
  let i: int = 0;
  while (i < found.found.length) {
    out = out + "[" + found.found[i].title + "](" + found.found[i].url + ")\n"
      + found.found[i].text + "\n\n";
    i = i + 1;
  }
  return out;
}

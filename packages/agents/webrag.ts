import { Db } from "../plume/driver.ts";
import { DbRepository, findById, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { agentWebRagRepository } from "./routes/agents/entities/agent-web-rag.entity.ts";
import { ModelRow, ModelConfigRow, modelsMapping } from "./schema.ts";
import { ToolSpec, complete, replyText, toolSpec } from "./provider.ts";
import { credentialFor } from "./credentials.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";
import { urlEncode } from "./mcp-oauth.ts";

export type AgentWebRagRow = {
  agentId: string,
  enabled: bool,
  topK: int,
  maxChars: int,
  queryMode: string,
  queryModelId: string,
};

export function agentWebRagMapping(): DbRepository {
  return agentWebRagRepository();
}

export function webRagPlan(db: Db): Migration[] {
  return [
    migration("95", "which agents read the web index", createTableSql(db, agentWebRagMapping())),
  ];
}

export function webRagFor(db: Db, agentId: string): AgentWebRagRow {
  let held = findById(db, agentWebRagMapping(), agentId);
  if (held == "") {
    let none: AgentWebRagRow = {
      agentId: agentId,
      enabled: false,
      topK: 5,
      maxChars: 6000,
      queryMode: "verbatim",
      queryModelId: "",
    };
    return none;
  }
  return JSON.parse<AgentWebRagRow>(held);
}

export function searchApiBase(): string {
  let set = process.env("JOULE_SEARCH_API") ?? "";
  if (set != "") {
    return set;
  }
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

export function generateQuery(db: Db, row: AgentWebRagRow, userText: string, master: string): string {
  if (row.queryMode != "generated" || row.queryModelId == "") {
    return userText;
  }
  let modelDoc = findById(db, modelsMapping(), row.queryModelId);
  if (modelDoc == "") {
    return userText;
  }
  let model: ModelRow = JSON.parse<ModelRow>(modelDoc);
  if (!model.enabled) {
    return userText;
  }
  let key = credentialFor(db, model.provider, master);
  if (key == "") {
    return userText;
  }

  let config: ModelConfigRow = {
    id: "", modelId: model.id, temperature: 0.0, maxTokens: 60, topP: 1.0,
    extra: "", thinking: "", label: "", selectable: false, rank: 0,
  };
  let asked = complete(model, config,
    "Write one short web-search query for the person's message. Answer with the query text only — "
    + "no quotes, no prefix, no explanation. Keep names, versions and error strings intact.",
    userText, key);
  if (!asked.ok) {
    return userText;
  }
  let q = replyText(model.provider, asked.text).trim();
  let brk = q.indexOf("\n");
  if (brk >= 0) {
    q = q.slice(0, brk).trim();
  }
  if (q.startsWith("\"") && q.endsWith("\"") && q.length > 1) {
    q = q.slice(1, q.length - 1);
  }
  if (q == "" || q.length > 300) {
    return userText;
  }
  return q;
}

export function retrieveWeb(query: string, topK: int, maxChars: int): WebFound {
  let url = searchApiBase() + "/retrieve?q=" + urlEncode(query)
    + "&k=" + `${topK}` + "&max_chars=" + `${maxChars}`;
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok) {
    let dead: WebFound = {
      ok: false,
      query: query,
      found: [],
      error: "the search index did not answer",
    };
    return dead;
  }
  if (res.status != 200) {
    let refused: WebFound = {
      ok: false,
      query: query,
      found: [],
      error: "the search index answered " + `${res.status}`,
    };
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
    if (p.text != "") {
      out.push(p);
    }
    i = i + 1;
  }
  let answer: WebFound = { ok: true, query: query, found: out, error: "" };
  return answer;
}

export function asWebContext(found: WebPassage[]): string {
  if (found.length == 0) {
    return "";
  }
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

export function webSummary(query: string, found: WebPassage[]): string {
  let urls: string[] = [];
  let i: int = 0;
  while (i < found.length) {
    urls.push(found[i].url);
    i = i + 1;
  }
  return "web index: \"" + query + "\" -> " + `${found.length}` + " passages (" + urls.join(", ") + ")";
}


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
  out.push(toolSpec("read_link",
    "Read one web page in full - an article the person attached or linked, or any URL "
    + "worth reading whole rather than searching for. The page is served from the "
    + "deployment's own index when the crawler already has it, and fetched live "
    + "otherwise, so this works for pages published minutes ago. Returns the page's "
    + "extracted text as markdown. When it refuses, it names why (a paywall shell, a "
    + "navigation page, a fetch error) - pass that on rather than guessing at the "
    + "page's contents.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"url\":{\"type\":\"string\",\"description\":\"The page to read, absolute http(s).\"}},"
    + "\"required\":[\"url\"]}"));
  return out;
}

export function callReadLinkTool(name: string, args: string): string {
  if (name != "read_link") {
    return "";
  }
  let url = jsonText(args, "url").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "read_link needs an absolute url: {\"url\":\"https://...\"}.";
  }
  let res = http.request(searchApiBase() + "/fetch?url=" + urlEncode(url), "GET", "", new Map<string, string>());
  if (!res.ok) {
    return "The page could not be fetched: the index did not answer.";
  }
  if (res.status == 422) {
    let why = jsonText(res.body, "reason");
    return "The page could not be read: " + (why == "" ? "the extractor refused it" : why)
      + ". Say so plainly rather than guessing at its contents.";
  }
  if (res.status != 200) {
    return "The page could not be fetched: the index answered " + `${res.status}` + ".";
  }
  let title = jsonText(res.body, "title");
  let md = jsonText(res.body, "markdown");
  let published = jsonText(res.body, "published_at");
  if (md == "") {
    return "The page answered but had no readable text.";
  }
  return "# " + title + "\n" + (published == "" ? "" : "Published: " + published + "\n")
    + "Source: " + url + "\n\n" + md;
}

export function callWebSearchTool(name: string, args: string): string {
  if (name != "search_web") {
    return "";
  }
  let query = jsonText(args, "query");
  if (query.trim() == "") {
    return "search_web needs a query: {\"query\":\"rust release notes\"}.";
  }
  let count = parseInt(jsonText(args, "count"), 10) ?? 5;
  if (count <= 0 || count > 20) {
    count = 5;
  }
  let found = retrieveWeb(query, count, 6000);
  if (!found.ok) {
    return "The search index did not answer: " + found.error;
  }
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

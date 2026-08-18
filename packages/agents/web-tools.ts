/* search_web, as an agent sees it.
 *
 * The description says what the index is, because a model that thinks this is
 * Google asks it questions and gets nothing: it matches the text of pages that
 * have been crawled, so keywords win and sentences lose.
 */

import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonText } from "./scan.ts";
import { searchBase, searchCount, searchPassagesRanked, searchQueryFault, searchRaw, searchReady, searchWeb, passageTexts } from "./web-search.ts";
import { rerankOrder, widenedCount } from "./web-rerank.ts";
import { Db } from "../plume/driver.ts";

export const SEARCH_WEB: string = "search_web";

export function webTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  if (!searchReady()) {
    return out;
  }
  out.push(toolSpec(SEARCH_WEB,
    "Search the web through this deployment's own index, and read what it finds. "
    + "What comes back is passages: each result is a page's real text under its title and url, "
    + "so there is usually nothing left to fetch — read the passages and answer from them, "
    + "citing the url you took a fact from. "
    + "It matches the text of pages that have been crawled, so ask it what a search engine can answer: "
    + "keywords, names, versions, an error string. Not a sentence, and not the person's whole message. "
    + "Use it when the answer depends on something recent, something you are unsure of, or anything "
    + "you would otherwise be guessing at.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"query\":{\"type\":\"string\",\"description\":\"The words to look for. Keywords, not a question.\"},"
    + "\"count\":{\"type\":\"integer\",\"description\":\"How many pages to read, 1 to 10. Five is the default and is usually right.\"}},"
    + "\"required\":[\"query\"]}"));
  return out;
}

export type WebToolCall = {
  name: string,
  args: string,
};

/** search_web, with the passages put in the order they should be read.
 *
 *  The index ranks lexically and will not rank by its own embeddings, so the
 *  index is asked for a wider set and this deployment's embedding model puts
 *  that set in order. Everything about it degrades to the plain search:
 *  no embedder, a refusal, an unreadable vector — all keep the index's order.
 *  See web-rerank.ts. */
export function callWebToolRanked(db: Db, master: string, call: WebToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.name != SEARCH_WEB) {
    return not;
  }
  let query = jsonText(call.args, "query");
  let want = searchCount(jsonText(call.args, "count"));
  let bad = searchQueryFault(query);
  if (bad != "") {
    let refused: FileToolResult = { handled: true, ok: false, text: bad, line: 0, changed: "" };
    return refused;
  }
  let document = searchRaw(searchBase(), query, widenedCount(want));
  if (document == "") {
    // The wide read failed; the ordinary one is a second chance rather than
    // an error, and it is the path every other caller already takes.
    return callWebTool(call);
  }
  let order = rerankOrder(db, master, query, passageTexts(document));
  let found = searchPassagesRanked(document, want, order);
  if (!found.ok) {
    let no: FileToolResult = { handled: true, ok: false, text: found.fault, line: 0, changed: "" };
    return no;
  }
  let read: FileToolResult = { handled: true, ok: true, text: found.text, line: 0, changed: "" };
  return read;
}

export function callWebTool(call: WebToolCall): FileToolResult {
  let not: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  if (call.name != SEARCH_WEB) {
    return not;
  }
  let found = searchWeb(jsonText(call.args, "query"), searchCount(jsonText(call.args, "count")));
  if (!found.ok) {
    let refused: FileToolResult = {
      handled: true, ok: false, text: found.fault, line: 0, changed: "",
    };
    return refused;
  }
  let read: FileToolResult = {
    handled: true, ok: true, text: found.text, line: 0, changed: "",
  };
  return read;
}

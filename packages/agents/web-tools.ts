/* search_web, as an agent sees it.
 *
 * The description says what the index is, because a model that thinks this is
 * Google asks it questions and gets nothing: it matches the text of pages that
 * have been crawled, so keywords win and sentences lose.
 */

import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonText } from "./scan.ts";
import { searchCount, searchReady, searchWeb } from "./web-search.ts";

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

/* Searching the web through an index this deployment can reach.
 *
 * A `WebIndex` is the seam, the shape plume's `Db` and the mail package's
 * `Mailer` have: a name, and one function that takes words and answers with
 * passages. Nothing above this line knows whose index it is. `passageIndex`
 * is the one implementation that ships — the /retrieve shape Joule's own
 * crawler serves — and a deployment with another index writes another one
 * rather than editing this file.
 *
 * Passages and not links, which is the property worth keeping whatever is
 * underneath: each result carries the page's real text under its title and
 * url, so an agent answers from the result instead of fetching the page
 * afterwards.
 *
 * Mounted only when AGENTS_SEARCH_API names an index. Until this existed the
 * search-web skill told the model to call search_web and nothing answered to
 * that name, so the call fell through to the skill of the same name and came
 * back as the skill's own instructions: a tool that looked like it ran, in six
 * milliseconds, having searched nothing.
 *
 * What comes back is somebody else's writing. run.ts fences it as untrusted,
 * and it must stay that way: a page that says "ignore your instructions" is
 * the oldest trick there is, and this is the tool that fetches pages.
 */

import { jsonList, jsonRaw, jsonText } from "./scan.ts";
import { excerptOf } from "./artifacts.ts";

/** How many passages one call may ask for. Ten pages of prose is already more
 *  than an answer needs, and the cost of a bad query is paid in context. */
const SEARCH_COUNT_MAX: int = 10;

const SEARCH_COUNT_DEFAULT: int = 5;

/** Characters of a single page kept, and of the whole answer. A passage is a
 *  page's text: without a cap one long article is the entire request. */
const SEARCH_PASSAGE_MAX: int = 1500;

const SEARCH_ANSWER_MAX: int = 9000;

/* The index's max_chars is a budget for the WHOLE answer, not for each
 * passage — measured: the same query at 2000 comes back with one passage, at
 * 20000 with six, at 200000 with twenty, and k does not move it at all. This
 * deployment asked for 3000 and was served exactly one passage for every
 * search it has ever run, whatever it asked k for. So the budget is asked for
 * per passage wanted, and generously, since each one is clipped to
 * SEARCH_PASSAGE_MAX on the way out anyway. */
const SEARCH_CHARS_EACH: int = 4000;

const SEARCH_CHARS_MAX: int = 200000;

export function searchBudget(count: int): int {
  let want = count * SEARCH_CHARS_EACH;
  return want > SEARCH_CHARS_MAX ? SEARCH_CHARS_MAX : want;
}


export function searchBase(): string {
  let said = (process.env("AGENTS_SEARCH_API") ?? "").trim();
  while (said.endsWith("/")) {
    said = said.slice(0, said.length - 1);
  }
  return said;
}

export function searchReady(): bool {
  return searchBase() != "";
}

export type Searched = {
  ok: bool,
  text: string,
  found: int,
  fault: string,
};

function searchRefused(why: string): Searched {
  let out: Searched = { ok: false, text: "", found: 0, fault: why };
  return out;
}

/** The count a call asked for, clamped rather than refused: a model that asks
 *  for fifty pages has made a judgement about breadth, not an error. */
export function searchCount(said: string): int {
  if (said.trim() == "") {
    return SEARCH_COUNT_DEFAULT;
  }
  let n = parseInt(said.trim(), 10) ?? SEARCH_COUNT_DEFAULT;
  if (n < 1) {
    return 1;
  }
  if (n > SEARCH_COUNT_MAX) {
    return SEARCH_COUNT_MAX;
  }
  return n;
}

export function searchQueryFault(query: string): string {
  let asked = query.trim();
  if (asked == "") {
    return "say what to look for: search_web({\"query\":\"lumen language release notes\"})";
  }
  if (asked.length > 300) {
    return "that query is " + `${asked.length}` + " characters — a search takes keywords, not a paragraph";
  }
  return "";
}

function searchEncoded(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    let ch = text.charAt(i);
    let plain = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 45 || c == 46 || c == 95 || c == 126;
    if (plain) {
      out = out + ch;
    } else if (c == 32) {
      out = out + "+";
    } else {
      out = out + "%" + searchHex(c / 16) + searchHex(c % 16);
    }
    i = i + 1;
  }
  return out;
}

function searchHex(n: int): string {
  let digits = "0123456789ABCDEF";
  return digits.charAt(n % 16);
}

function searchClipped(text: string, cap: int): string {
  if (text.length <= cap) {
    return text;
  }
  // excerptOf, not slice: strings here are UTF-8 bytes, and a cut that lands
  // inside a character makes a string that is not UTF-8 — which leaves this
  // process as an ARRAY OF BYTES when the tool turn is serialized into the
  // next completion request. DeepSeek answered that with a 400 naming
  // messages[5], intermittently, on whichever passages put a multibyte
  // character under the cap.
  return excerptOf(text, cap) + "\n[…this passage is longer; the rest was not read]";
}

/** The index's answer, as the model reads it: one block per page, the url on
 *  its own line so a citation can be copied out of it. */
export function searchPassages(document: string, count: int): Searched {
  let rows = jsonList(jsonRaw(document, "passages"));
  if (rows.length == 0) {
    let none: Searched = {
      ok: true, found: 0,
      text: "The index has nothing for that. Try other words, or fewer of them —"
        + " it matches text on pages it has crawled, not a question.",
      fault: "",
    };
    return none;
  }
  let out = "";
  let taken: int = 0;
  let i: int = 0;
  while (i < rows.length && taken < count && out.length < SEARCH_ANSWER_MAX) {
    let title = jsonText(rows[i], "title");
    let url = jsonText(rows[i], "url");
    let text = jsonText(rows[i], "text");
    if (text.trim() == "") {
      text = jsonText(rows[i], "snippet");
    }
    if (url != "") {
      let when = jsonText(rows[i], "published_at");
      out = out + (out == "" ? "" : "\n\n")
        + (title == "" ? url : title) + "\n" + url
        + (when == "" ? "" : "\npublished " + when) + "\n"
        + searchClipped(text.trim(), SEARCH_PASSAGE_MAX);
      taken = taken + 1;
    }
    i = i + 1;
  }
  if (taken == 0) {
    return searchRefused("the index answered with nothing this tool could read");
  }
  let done: Searched = { ok: true, text: out, found: taken, fault: "" };
  return done;
}

/** An index this deployment can search. One function, so an index with
 *  another wire format is another module and not an edit here. */
export type WebIndex = {
  name: string,
  find: (base: string, query: string, count: int) => Searched,
};

/** How the index ranks. "vector" asks for semantic matching over the
 *  embeddings the index already holds; empty sends nothing and takes the
 *  index's own default. An index that does not know the parameter ignores
 *  it, so this is safe to say to any of them. */
function searchMode(): string {
  return (process.env("AGENTS_SEARCH_MODE") ?? "").trim();
}

/** The /retrieve shape: q, k and max_chars in, a "passages" array out, each
 *  carrying url, title and the page's own text. */
function passageFind(base: string, query: string, count: int): Searched {
  let mode = searchMode();
  let url = base + "/retrieve?q=" + searchEncoded(query.trim())
    + "&k=" + `${count}` + "&max_chars=" + `${searchBudget(count)}`
    + (mode == "" ? "" : "&mode=" + searchEncoded(mode));
  let headers = new Map<string, string>();
  headers.set("accept", "application/json");
  let res = http.request(url, "GET", "", headers);
  if (res.status < 0) {
    return searchRefused("the index did not answer");
  }
  if (res.status < 200 || res.status > 299) {
    let said = res.body.length > 200 ? res.body.slice(0, 200) : res.body;
    return searchRefused("the index answered " + `${res.status}`
      + (said == "" ? "" : ": " + said));
  }
  return searchPassages(res.body, count);
}

export function passageIndex(): WebIndex {
  let out: WebIndex = { name: "passages", find: passageFind };
  return out;
}

/** Validate here, fetch there. The index is given rather than chosen, so a
 *  test searches through a fake one and nothing here needs a network. */
export function searchWith(index: WebIndex, base: string, query: string, count: int): Searched {
  if (base == "") {
    return searchRefused("this deployment has no web index configured");
  }
  let bad = searchQueryFault(query);
  if (bad != "") {
    return searchRefused(bad);
  }
  return index.find(base, query, count);
}

export function searchWeb(query: string, count: int): Searched {
  return searchWith(passageIndex(), searchBase(), query, count);
}



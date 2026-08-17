import { Searched, WebIndex, searchCount, searchPassages, searchQueryFault, searchReady, searchWith } from "./web-search.ts";
import { SEARCH_WEB, callWebTool, webTools } from "./web-tools.ts";
import { reservedHere } from "./reserved.ts";

/** What the index answers with, trimmed to the fields this reads. */
function indexSaid(passages: string): string {
  return "{\"query\":\"iphone 18\",\"passages\":[" + passages + "]}";
}

function passage(url: string, title: string, text: string): string {
  return "{\"url\":" + JSON.stringify(url) + ",\"title\":" + JSON.stringify(title)
    + ",\"domain\":\"example.com\",\"score\":10,\"published_at\":\"2026-08-11T20:12:50.000Z\""
    + ",\"text\":" + JSON.stringify(text) + "}";
}

test("a passage arrives as its title, its url and its words", () => {
  let said = searchPassages(indexSaid(
    passage("https://example.com/a", "Release date leaks", "It ships in September.")), 5);

  expect(said.ok);
  expect(said.found == 1);
  expect(said.text.indexOf("Release date leaks") == 0);
  // The url on its own line, so a citation can be lifted out of it.
  expect(said.text.indexOf("\nhttps://example.com/a\n") > 0);
  expect(said.text.indexOf("It ships in September.") > 0);
  expect(said.text.indexOf("published 2026-08-11") > 0);
});

test("count is what the caller asked for, and never more than the index sent", () => {
  let three = indexSaid(passage("https://a.example/1", "One", "first")
    + "," + passage("https://a.example/2", "Two", "second")
    + "," + passage("https://a.example/3", "Three", "third"));

  expect(searchPassages(three, 5).found == 3);
  expect(searchPassages(three, 2).found == 2);
  expect(searchPassages(three, 2).text.indexOf("third") < 0);
});

test("a long page is clipped, and says that it was", () => {
  let long = "";
  let i: int = 0;
  while (i < 400) {
    long = long + "one two three four five six seven ";
    i = i + 1;
  }
  let said = searchPassages(indexSaid(passage("https://a.example/1", "Long", long)), 5);

  expect(said.ok);
  expect(said.text.length < long.length);
  expect(said.text.indexOf("the rest was not read") > 0);
});

test("nothing found is an answer, not a failure", () => {
  let said = searchPassages("{\"query\":\"zzz\",\"passages\":[]}", 5);

  expect(said.ok);
  expect(said.found == 0);
  expect(said.text.indexOf("nothing for that") > 0);
  // and it says what would help, since the index matches text and not questions
  expect(said.text.indexOf("crawled") > 0);
});

test("a passage with no url is skipped rather than cited as nothing", () => {
  let said = searchPassages(indexSaid("{\"title\":\"No url\",\"text\":\"words\"}"), 5);
  expect(!said.ok);
  expect(said.fault.indexOf("nothing this tool could read") > 0);
});

test("a count is clamped, because breadth is a judgement and not an error", () => {
  expect(searchCount("") == 5);
  expect(searchCount("3") == 3);
  expect(searchCount("50") == 10);
  expect(searchCount("0") == 1);
  expect(searchCount("not a number") == 5);
});

test("a query has to be words, and not a paragraph", () => {
  expect(searchQueryFault("lumen release notes") == "");
  expect(searchQueryFault("   ").indexOf("say what to look for") == 0);
  let essay = "";
  let i: int = 0;
  while (i < 40) {
    essay = essay + "a sentence about something ";
    i = i + 1;
  }
  expect(searchQueryFault(essay).indexOf("keywords, not a paragraph") > 0);
});

test("with no index configured the tool is not offered at all", () => {
  // AGENTS_SEARCH_API is unset in a suite, so this is the honest default: a
  // deployment with no index does not tell a model it can search.
  expect(!searchReady());
  expect(webTools().length == 0);
});

// An index that answers without a network, to prove what is asked of one.
let askedBase: string = "";
let askedQuery: string = "";
let askedCount: int = 0;

function noteFind(base: string, query: string, count: int): Searched {
  askedBase = base;
  askedQuery = query;
  askedCount = count;
  let out: Searched = { ok: true, text: "found", found: 1, fault: "" };
  return out;
}

function noting(): WebIndex {
  let out: WebIndex = { name: "noting", find: noteFind };
  return out;
}

test("the index is handed the words, and never reached when there are none", () => {
  askedBase = "";
  let ok = searchWith(noting(), "https://index.example", "lumen release notes", 3);
  expect(ok.ok);
  expect(askedBase == "https://index.example");
  expect(askedQuery == "lumen release notes");
  expect(askedCount == 3);

  askedBase = "";
  let empty = searchWith(noting(), "https://index.example", "   ", 3);
  expect(!empty.ok);
  expect(askedBase == "");

  let nowhere = searchWith(noting(), "", "words", 3);
  expect(!nowhere.ok);
  expect(nowhere.fault.indexOf("no web index configured") > 0);
  expect(askedBase == "");
});

test("a call this family does not own is left for the next one", () => {
  expect(!callWebTool({ name: "read_artifact", args: "{}" }).handled);
});

test("search_web is a name this deployment owns, so a skill cannot answer to it", () => {
  // The skill is called search-web and the tool search_web. Before the guard
  // in callSkillTool, the skill answered the tool call with its own body.
  expect(reservedHere(SEARCH_WEB));
});

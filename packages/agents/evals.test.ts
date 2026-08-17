import { langfuseBackend, otlpBackend, noBackend } from "../tracing/backend.ts";
import { DatasetSummary, EvalItem, Verdict, hasDataset, namesJson, onlyOne, evalApiBase, readVerdict, judgePrompt, compareNumbers, numbersIn, namesIn, missingFrom, reachedScore, missingReason } from "./evals.ts";

function item(question: string, expected: string): EvalItem {
  let none: string[] = [];
  let it: EvalItem = { id: "i1", question: question, expected: expected,
    expectedTools: none, expectedAgents: none, expectedScopes: none };
  return it;
}

test("the backend says where its cases live", () => {
  expect(evalApiBase(langfuseBackend("http://localhost:3000", "pk", "sk")) == "http://localhost:3000");
});

test("a backend with no datasets says so rather than offering a url", () => {
  expect(evalApiBase(otlpBackend("http://otel-collector:4318/v1/traces", "", "")) == "");
  expect(evalApiBase(noBackend()) == "");
});

test("a judge's score and reason are read", () => {
  let v = readVerdict("{\"score\": 1, \"reason\": \"the numbers match\"}");
  expect(v.ok);
  expect(v.score == 1.0);
  expect(v.reason == "the numbers match");
});

test("a score outside 0 to 1 is clamped rather than trusted", () => {
  expect(readVerdict("{\"score\": 5}").score == 1.0);
  expect(readVerdict("{\"score\": -2}").score == 0.0);
});

test("a judge that answered in prose has not judged", () => {
  let v = readVerdict("I think the answer looks pretty good overall.");
  expect(!v.ok);
  expect(v.score == 0.0);
  expect(v.reason.indexOf("did not answer with a score") >= 0);
});

test("a score that is not a number is not a score", () => {
  let v = readVerdict("{\"score\": \"high\", \"reason\": \"good\"}");
  expect(!v.ok);
  expect(v.reason.indexOf("not a number") >= 0);
});

test("the judge is shown the reference rather than asked to match it", () => {
  let p = judgePrompt("How many A-114 in Lyon?", "4 units.", "There are 4.");
  expect(p.indexOf("Reference answer") >= 0);
  expect(p.indexOf("Wording, order and extra detail do not matter") >= 0);
  expect(p.indexOf("JSON only") >= 0);
});

test("numbers are pulled out as written", () => {
  let ns = numbersIn("37 units of A-114 at EUR 12.50 each");
  expect(ns.length == 3);
  expect(ns[0] == "37");
  expect(ns[1] == "114");
  expect(ns[2] == "12.50");
});

test("a full stop after a number is not part of it", () => {
  let ns = numbersIn("There are 4 units.");
  expect(ns[0] == "4");
});

test("an answer carrying every reference number scores 1", () => {
  let v = compareNumbers(item("what is the bill?", "EUR 462.50 for 37 units"),
                         "The bill is EUR 462.50, since only 37 units are in stock.");
  expect(v.ok);
  expect(v.score == 1.0);
});

test("an answer missing a number scores below 1", () => {
  let v = compareNumbers(item("stock and price?", "37 units at EUR 12.50"),
                         "There are 37 units in Rotterdam.");
  expect(v.ok);
  expect(v.score < 1.0);
  expect(v.score > 0.0);
  expect(v.reason.indexOf("no judge configured") >= 0);
});

test("a contradicting answer scores 0", () => {
  let v = compareNumbers(item("how many?", "4 units"), "There are 12 units.");
  expect(v.ok);
  expect(v.score == 0.0);
});

test("a reference with no numbers is not graded by this judge", () => {
  let v = compareNumbers(item("who should I ask?", "Ask the parts desk."), "Ask the parts desk.");
  expect(!v.ok);
  expect(v.reason.indexOf("no numbers to compare") >= 0);
});

test("a case can name the tools and agents it expects", () => {
  expect(namesIn("[\"warehouse_stock\",\"part_price\"]").length == 2);
  expect(namesIn("[\"warehouse_stock\"]")[0] == "warehouse_stock");
  expect(namesIn("\"parts-desk\"")[0] == "parts-desk");
  expect(namesIn("").length == 0);
  expect(namesIn("[]").length == 0);
});

test("what was expected and not reached is named", () => {
  let expected: string[] = ["warehouse_stock", "part_price"];
  let reached: string[] = ["warehouse_stock"];
  let missing = missingFrom(expected, reached);
  expect(missing.length == 1);
  expect(missing[0] == "part_price");
});

test("reaching everything scores 1, reaching none scores 0", () => {
  let both: string[] = ["a", "b"];
  let one: string[] = ["a"];
  let neither: string[] = ["z"];
  expect(reachedScore(both, both) == 1.0);
  expect(reachedScore(both, one) == 0.5);
  expect(reachedScore(both, neither) == 0.0);
});

test("a case expecting no route cannot fail one", () => {
  let none: string[] = [];
  let used: string[] = ["warehouse_stock"];
  expect(reachedScore(none, used) == 1.0);
  expect(reachedScore(none, none) == 1.0);
  expect(missingFrom(none, used).length == 0);
});

test("a route failure says what was missed and what ran instead", () => {
  let missing: string[] = ["warehouse_stock"];
  let reached: string[] = ["part_price"];
  let why = missingReason("tools", missing, reached);
  expect(why.indexOf("never reached warehouse_stock") >= 0);
  expect(why.indexOf("part_price") >= 0);

  let nothing: string[] = [];
  expect(missingReason("tools", missing, nothing).indexOf("nothing") >= 0);
});

test("a satisfied route expectation says what was reached", () => {
  let none: string[] = [];
  let reached: string[] = ["warehouse_stock", "part_price"];
  let why = missingReason("tools", none, reached);
  expect(why.indexOf("every expected tool was reached") >= 0);
  expect(why.indexOf("warehouse_stock") >= 0);
});

test("a case can name the folders an answer should come from", () => {
  let expected: string[] = ["/specs/plume"];
  let usedNothing: string[] = [];
  expect(reachedScore(expected, usedNothing) == 0.0);
  expect(missingFrom(expected, usedNothing)[0] == "/specs/plume");

  let usedRight: string[] = ["/specs/plume"];
  expect(reachedScore(expected, usedRight) == 1.0);

  let usedWrong: string[] = ["/policies"];
  expect(reachedScore(expected, usedWrong) == 0.0);
});

test("a case's expectations are written as JSON the reader takes back", () => {
  let none: string[] = [];
  expect(namesJson(none) == "[]");

  let two: string[] = ["warehouse_stock", "part_price"];
  expect(namesJson(two) == "[\"warehouse_stock\",\"part_price\"]");

  let quoted: string[] = ["say \"hello\""];
  expect(namesIn(namesJson(quoted))[0] == "say \"hello\"");
});

test("a set of cases is known by name, not by position", () => {
  let sets: DatasetSummary[] = [
    { name: "parts-desk-evals", description: "" },
    { name: "scoped-rag", description: "how retrieval is scoped" },
  ];
  expect(hasDataset(sets, "scoped-rag"));
  expect(!hasDataset(sets, "Scoped-RAG"));
  expect(!hasDataset(sets, ""));
});

test("a run can be asked for one case rather than the top of the set", () => {
  let a = item("first?", "1");
  let b: EvalItem = { id: "i2", question: "second?", expected: "2",
    expectedTools: [], expectedAgents: [], expectedScopes: [] };
  let both: EvalItem[] = [a, b];

  expect(onlyOne(both, "").length == 2);
  expect(onlyOne(both, "i2").length == 1);
  expect(onlyOne(both, "i2")[0].question == "second?");
  expect(onlyOne(both, "gone").length == 0);
});

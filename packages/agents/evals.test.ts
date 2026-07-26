// Evals: what is read out of a dataset, what a judge's reply means, and how
// answers are graded when nobody has configured a judge.
//
// The live half — fetching a dataset, running the tree, posting scores — is
// examples/evals.ts against a real Langfuse, because a test that needs a
// listening collector is a test that gets skipped.
//
//   cd packages/agents && lumen test evals.test.ts

import { langfuseBackend, otlpBackend, noBackend } from "../tracing/backend.ts";
import { EvalItem, Verdict, evalApiBase, readVerdict, judgePrompt, compareNumbers, numbersIn, namesIn, missingFrom, reachedScore, missingReason } from "./evals.ts";

function item(question: string, expected: string): EvalItem {
  let none: string[] = [];
  let it: EvalItem = { id: "i1", question: question, expected: expected,
    expectedTools: none, expectedAgents: none, expectedScopes: none };
  return it;
}

// --- where the datasets live ------------------------------------------------------

test("the backend says where its cases live", () => {
  // Asked, not sniffed from a URL: whether a backend has datasets is a fact
  // about the backend, and a path suffix is a guess.
  expect(evalApiBase(langfuseBackend("http://localhost:3000", "pk", "sk")) == "http://localhost:3000");
});

test("a backend with no datasets says so rather than offering a url", () => {
  // Datasets are not an OpenTelemetry concept. Building a URL that 404s would
  // be a worse answer than saying there is nowhere to look.
  expect(evalApiBase(otlpBackend("http://otel-collector:4318/v1/traces", "", "")) == "");
  expect(evalApiBase(noBackend()) == "");
});

// --- reading a judge --------------------------------------------------------------

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
  // Scoring this 0 would read as "the answer was wrong" when what happened is
  // "the judge did not grade it".
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
  // And is told to answer in JSON, because a prose verdict cannot be scored.
  expect(p.indexOf("JSON only") >= 0);
});

// --- grading with no judge configured ----------------------------------------------

test("numbers are pulled out as written", () => {
  // Three, not four: the "114" in "A-114" is one of them, which is the point
  // of comparing what is written rather than parsing values out of prose.
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
  // And says what it counted, because 0.5 with no explanation is not a grade.
  expect(v.reason.indexOf("no judge configured") >= 0);
});

test("a contradicting answer scores 0", () => {
  let v = compareNumbers(item("how many?", "4 units"), "There are 12 units.");
  expect(v.ok);
  expect(v.score == 0.0);
});

test("a reference with no numbers is not graded by this judge", () => {
  // It grades numbers. Saying so beats returning 0, which would read as a
  // wrong answer.
  let v = compareNumbers(item("who should I ask?", "Ask the parts desk."), "Ask the parts desk.");
  expect(!v.ok);
  expect(v.reason.indexOf("no numbers to compare") >= 0);
});

// --- the route, not just the answer -----------------------------------------------

test("a case can name the tools and agents it expects", () => {
  expect(namesIn("[\"warehouse_stock\",\"part_price\"]").length == 2);
  expect(namesIn("[\"warehouse_stock\"]")[0] == "warehouse_stock");
  // A case that wrote one name without a list meant a list of one.
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
  // Most cases only care about the answer, and they must not be dragged to
  // zero by a check they never asked for.
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

  // And a run that reached nothing at all says so rather than reading as an
  // empty list.
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
  // The failure the other route checks miss: a right answer that retrieved
  // nothing, recited from pre-training and wrong the day the documents change.
  let expected: string[] = ["/specs/plume"];
  let usedNothing: string[] = [];
  expect(reachedScore(expected, usedNothing) == 0.0);
  expect(missingFrom(expected, usedNothing)[0] == "/specs/plume");

  let usedRight: string[] = ["/specs/plume"];
  expect(reachedScore(expected, usedRight) == 1.0);

  // And drawn from the wrong shelf, which reads as correct until you check.
  let usedWrong: string[] = ["/policies"];
  expect(reachedScore(expected, usedWrong) == 0.0);
});

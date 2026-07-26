// Evals: what is read out of a dataset, what a judge's reply means, and how
// answers are graded when nobody has configured a judge.
//
// The live half — fetching a dataset, running the tree, posting scores — is
// examples/evals.ts against a real Langfuse, because a test that needs a
// listening collector is a test that gets skipped.
//
//   cd packages/agents && lumen test evals.test.ts

import { EvalItem, Verdict, langfuseBase, readVerdict, judgePrompt, compareNumbers, numbersIn } from "./evals.ts";

function item(question: string, expected: string): EvalItem {
  let it: EvalItem = { id: "i1", question: question, expected: expected };
  return it;
}

// --- where the datasets live ------------------------------------------------------

test("the api root is the trace endpoint without the otlp path", () => {
  expect(langfuseBase("http://localhost:3000/api/public/otel/v1/traces") == "http://localhost:3000");
  expect(langfuseBase("https://cloud.langfuse.com/api/public/otel/v1/traces") == "https://cloud.langfuse.com");
});

test("a collector that is not langfuse has no datasets", () => {
  // Reported as absent rather than guessed at: building a URL that 404s would
  // be a worse answer than saying there is nowhere to look.
  expect(langfuseBase("http://otel-collector:4318/v1/traces") == "");
  expect(langfuseBase("") == "");
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

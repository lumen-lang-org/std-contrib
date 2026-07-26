// Evaluations: a dataset kept in Langfuse, run on demand against an agent.
//
//   let out = runEvals(db, "a1", "judge1", "parts-desk-evals", "nightly", master);
//
// The cases live where the people who write them work — Langfuse datasets —
// rather than in a fixture file only a programmer can edit. Running them is a
// request, not a deployment: the agent, its sub-agents, its tools and the
// judge are all rows, so what a run measures is whatever the database says
// today.
//
// Each case gets its own trace, linked back to the dataset run, and a score.
// That is the point of doing it here rather than in a test: a failing case
// comes with the whole tree underneath it — which sub-agent was asked, what
// the tool returned — instead of a diff.

import { Db } from "../plume/driver.ts";
import { AgentRun, runAgentTraced } from "./run.ts";
import { Tracer, traceId, tracerForCallee, flush, tracerWithMoreSpans, tracing, noTracer, resetTracer } from "../tracing/tracing.ts";
import { jsonRaw, jsonText, jsonList, jsonStringMember } from "./scan.ts";

// One case: what to ask, and what a good answer looks like.
export type EvalItem = {
  id: string,
  question: string,
  expected: string,
};

// What one case did.
export type EvalResult = {
  itemId: string,
  question: string,
  expected: string,
  answer: string,
  traceId: string,
  // 0 to 1. A judge's number, not a distance — an answer can be right in
  // words the expected output never used.
  score: number,
  reason: string,
  // Whether the *run* worked, which is not whether the answer was good. A run
  // that failed has no score worth reading.
  ran: bool,
  error: string,
  delegations: int,
  rounds: int,
};

export type EvalRun = {
  ok: bool,
  dataset: string,
  runName: string,
  items: int,
  scored: int,
  // How many scored at or above the pass mark.
  passed: int,
  meanScore: number,
  results: EvalResult[],
  error: string,
};

// A score at or above this counts as a pass. Judges are asked for a number
// because "did it pass" is a threshold someone should be able to move without
// re-running anything; this is only what the summary counts.
const PASS_MARK: number = 0.7;

// --- talking to Langfuse ---------------------------------------------------------

// The API root, from the OTLP endpoint tracing already knows.
//
// Derived rather than stored as its own column: the two are the same
// deployment, and a second field is a second thing to get wrong. A collector
// that is not Langfuse has no datasets, and this returns "" so the caller can
// say so instead of building a URL that will 404.
export function langfuseBase(endpoint: string): string {
  let marker = "/api/public/otel/v1/traces";
  let at = endpoint.indexOf(marker);
  if (at < 0) { return ""; }
  return endpoint.slice(0, at);
}

function jsonHeaders(auth: string): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", auth);
  return headers;
}

// The cases in a dataset, in the order Langfuse returns them.
//
// Paged, because a dataset worth having outgrows one page and a silent first
// fifty is a suite that passes by not running.
export function datasetItems(base: string, auth: string, dataset: string, maxItems: int): EvalItem[] {
  let out: EvalItem[] = [];
  if (base == "") { return out; }
  let page: int = 1;
  while (out.length < maxItems) {
    let url = base + "/api/public/dataset-items?datasetName=" + dataset
      + "&limit=50&page=" + `${page}`;
    let res = http.request(url, "GET", "", jsonHeaders(auth));
    if (!res.ok || res.status != 200) { return out; }

    let items = jsonList(jsonRaw(res.body, "data"));
    if (items.length == 0) { return out; }

    let i: int = 0;
    while (i < items.length && out.length < maxItems) {
      // The input and expected output are whatever shape whoever wrote the
      // case used. `question` and `answer` are this package's convention; a
      // case that does not use them still runs, with the whole object as the
      // text, because refusing it would be worse than asking it verbatim.
      let input = jsonRaw(items[i], "input");
      let question = jsonText(input, "question");
      if (question == "") { question = input; }
      let expectedRaw = jsonRaw(items[i], "expectedOutput");
      let expected = jsonText(expectedRaw, "answer");
      if (expected == "") { expected = expectedRaw; }

      let item: EvalItem = {
        id: jsonText(items[i], "id"),
        question: question,
        expected: expected,
      };
      if (item.id != "" && item.question != "") { out.push(item); }
      i = i + 1;
    }

    // `totalPages` says whether there is more; without it one page would look
    // like the whole dataset.
    let pages = jsonRaw(res.body, "totalPages");
    if (pages == "" || `${page}` == pages) { return out; }
    page = page + 1;
  }
  return out;
}

// Attach a run's trace to the case it answered, so Langfuse shows the dataset
// run as a table of traces rather than a column of numbers.
export function linkRunItem(base: string, auth: string, runName: string, itemId: string, runTraceId: string): bool {
  if (base == "" || runTraceId == "") { return false; }
  let body = "{\"runName\":" + JSON.stringify(runName)
    + ",\"datasetItemId\":" + JSON.stringify(itemId)
    + ",\"traceId\":" + JSON.stringify(runTraceId) + "}";
  let res = http.request(base + "/api/public/dataset-run-items", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

// Record what the judge said, against the trace it judged.
export function postScore(base: string, auth: string, runTraceId: string, name: string, value: number, comment: string): bool {
  if (base == "" || runTraceId == "") { return false; }
  let body = "{\"traceId\":" + JSON.stringify(runTraceId)
    + ",\"name\":" + JSON.stringify(name)
    + ",\"value\":" + `${value}`
    + ",\"dataType\":\"NUMERIC\""
    + ",\"comment\":" + JSON.stringify(comment) + "}";
  let res = http.request(base + "/api/public/scores", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

// --- judging ----------------------------------------------------------------------

export type Verdict = {
  score: number,
  reason: string,
  ok: bool,
};

// What the judge is asked. The expected answer is given as a reference rather
// than as a target string, because an answer can be right in words the case
// never used — "37 in stock, so no" and "No, only 37 units" are the same
// answer and a string comparison would fail one of them.
export function judgePrompt(question: string, expected: string, answer: string): string {
  return "Question asked:\n" + question
    + "\n\nReference answer:\n" + expected
    + "\n\nAnswer to judge:\n" + answer
    + "\n\nDoes the answer say the same thing as the reference? Wording, order and"
    + " extra detail do not matter; the facts and the numbers do. A missing"
    + " number that the question asked for is a failure. Reply with JSON only:"
    + " {\"score\": <0 to 1>, \"reason\": \"<one sentence>\"}";
}

// Read a judge's reply. A judge that answers in prose rather than JSON has not
// judged — reporting that beats scoring it 0, which would look like the answer
// was wrong rather than the judge.
export function readVerdict(text: string): Verdict {
  let raw = jsonRaw(text, "score");
  if (raw == "") {
    let unusable: Verdict = { score: 0.0, reason: "the judge did not answer with a score: " + text.slice(0, 120), ok: false };
    return unusable;
  }
  // parseFloat answers null on anything that is not a number, and a judge
  // that wrote `"score": "high"` has not scored.
  let parsed = parseFloat(raw);
  if (parsed == null) {
    let unreadable: Verdict = { score: 0.0, reason: "the judge's score was not a number: " + raw, ok: false };
    return unreadable;
  }
  let value: number = parsed;
  if (value < 0.0) { value = 0.0; }
  if (value > 1.0) { value = 1.0; }
  let why = jsonStringMember(text, "reason");
  let out: Verdict = { score: value, reason: why.text, ok: true };
  return out;
}

// Judge one answer with an agent. The judge is an agent like any other, so
// which model judges, and how strictly, is a row — and a judge can be swapped
// without touching this file.
//
// With no judge configured, the built-in one below grades instead. A suite
// that refuses to run because nobody has set up a judge yet is a suite nobody
// sets up a judge for.
export function judgeAnswer(db: Db, judgeAgentId: string, item: EvalItem, answer: string, master: string): Verdict {
  if (judgeAgentId == "") { return compareNumbers(item, answer); }
  let asked = runAgentTraced(db, judgeAgentId, judgePrompt(item.question, item.expected, answer), master, judgeTracer());
  if (!asked.ok) {
    // Named rather than silently fallen back from: a judge that was configured
    // and did not run is a different problem from no judge at all, and
    // grading anyway would hide it.
    let broken: Verdict = { score: 0.0, reason: "the judge could not run: " + asked.error, ok: false };
    return broken;
  }
  return readVerdict(asked.text);
}

// The judge used when none is configured.
//
// It compares the numbers, because that is what these answers turn on: a
// stock level, a price, a total. An answer carrying every number the reference
// carries is almost certainly the same answer; one missing a number is not.
// It says nothing about tone, completeness or reasoning — a model judge is
// better and this is what you get without one, which is more than nothing.
export function compareNumbers(item: EvalItem, answer: string): Verdict {
  let wanted = numbersIn(item.expected);
  if (wanted.length == 0) {
    // Nothing to compare. Refusing to score beats inventing one.
    let unscored: Verdict = { score: 0.0, reason: "no judge configured, and the reference answer has no numbers to compare", ok: false };
    return unscored;
  }
  let found: int = 0;
  let i: int = 0;
  while (i < wanted.length) {
    if (answer.indexOf(wanted[i]) >= 0) { found = found + 1; }
    i = i + 1;
  }
  let score: number = (found + 0.0) / (wanted.length + 0.0);
  let out: Verdict = {
    score: score,
    reason: "no judge configured: " + `${found}` + " of " + `${wanted.length}`
      + " numbers in the reference answer appear in the answer",
    ok: true,
  };
  return out;
}

// Every run of digits in a string, as written. Compared as text rather than as
// values because "37" and "37.0" are not the same answer to a person reading
// a stock level, and formatting is part of what an answer got right.
export function numbersIn(text: string): string[] {
  let out: string[] = [];
  let current = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    let digit = c >= 48 && c <= 57;
    // A decimal point continues a number; it does not start one.
    let inner = current != "" && (text.charAt(i) == "." || text.charAt(i) == ",");
    if (digit || inner) {
      current = current + text.charAt(i);
    } else {
      if (current != "") { out.push(trimTrailingPoint(current)); }
      current = "";
    }
    i = i + 1;
  }
  if (current != "") { out.push(trimTrailingPoint(current)); }
  return out;
}

// "37." at the end of a sentence is the number 37 and a full stop.
function trimTrailingPoint(value: string): string {
  let out = value;
  while (out.endsWith(".") || out.endsWith(",")) { out = out.slice(0, out.length - 1); }
  return out;
}

// The judge runs untraced. Its spans would sit in the same trace as the answer
// it is judging and read as work the agent did, which is the opposite of what
// a trace is for.
function judgeTracer(): Tracer {
  return noTracer();
}

// A run that did not happen, and why.
function noEvals(dataset: string, runName: string, why: string): EvalRun {
  let none: EvalResult[] = [];
  let out: EvalRun = {
    ok: false, dataset: dataset, runName: runName, items: 0, scored: 0,
    passed: 0, meanScore: 0.0, results: none, error: why,
  };
  return out;
}

// --- the run ------------------------------------------------------------------------

// Run every case in a dataset against an agent, judging each answer.
//
// `tracer` carries the collector and the credentials; each case gets its own
// trace from it, because a dataset run is many runs and one trace holding all
// of them would be unreadable.
export function runEvals(db: Db, agentId: string, judgeAgentId: string, dataset: string, runName: string, tracer: Tracer, master: string, maxItems: int): EvalRun {
  let results: EvalResult[] = [];

  if (!tracing(tracer)) {
    return noEvals(dataset, runName, "tracing is not configured, and the cases live in Langfuse");
  }
  let base = langfuseBase(tracer.endpoint);
  if (base == "") {
    return noEvals(dataset, runName, "the trace endpoint is not a Langfuse instance, so it has no datasets");
  }

  let items = datasetItems(base, tracer.auth, dataset, maxItems);
  if (items.length == 0) {
    return noEvals(dataset, runName, "no cases in dataset \"" + dataset + "\"");
  }

  let total: number = 0.0;
  let scored: int = 0;
  let passed: int = 0;

  let i: int = 0;
  while (i < items.length) {
    // One trace per case, all in the same dataset run.
    // resetTracer keeps the connection and takes a new trace id: each case is
    // its own trace, because twenty runs in one tree is not a tree anyone reads.
    let caseTracer = resetTracer(tracer);
    let answered = runAgentTraced(db, agentId, items[i].question, master, caseTracer);

    let delegations: int = 0;
    let s: int = 0;
    while (s < answered.steps.length) {
      if (answered.steps[s].tool.startsWith("ask_")) { delegations = delegations + 1; }
      s = s + 1;
    }

    let caseTrace = traceId(caseTracer);

    // The trace goes up whatever happened: a case that failed to run is the
    // one someone most wants to look at.
    flush(tracerWithMoreSpans(caseTracer, answered.spans));
    linkRunItem(base, tracer.auth, runName, items[i].id, caseTrace);

    // Judged only if it ran. A run that never reached the model has no answer
    // to score, and a 0 there would read as a wrong answer rather than no
    // answer.
    let score: number = 0.0;
    let reason = "";
    let why = answered.error;
    if (answered.ok) {
      let verdict = judgeAnswer(db, judgeAgentId, items[i], answered.text, master);
      score = verdict.score;
      reason = verdict.reason;
      if (verdict.ok) {
        scored = scored + 1;
        total = total + verdict.score;
        if (verdict.score >= PASS_MARK) { passed = passed + 1; }
        postScore(base, tracer.auth, caseTrace, "correctness", verdict.score, verdict.reason);
      } else {
        why = verdict.reason;
      }
    }

    let result: EvalResult = {
      itemId: items[i].id,
      question: items[i].question,
      expected: items[i].expected,
      answer: answered.text,
      traceId: caseTrace,
      score: score,
      reason: reason,
      ran: answered.ok,
      error: why,
      delegations: delegations,
      rounds: answered.rounds,
    };
    results.push(result);
    i = i + 1;
  }

  let mean: number = 0.0;
  if (scored > 0) { mean = total / scored; }
  let out: EvalRun = {
    ok: true, dataset: dataset, runName: runName, items: items.length,
    scored: scored, passed: passed, meanScore: mean, results: results, error: "",
  };
  return out;
}

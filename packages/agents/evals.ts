import { Db } from "../plume/driver.ts";
import { AgentRun, runAgentFor, runAgentTraced, hasName } from "./run.ts";
import { TraceBackend, hasDatasets } from "../tracing/backend.ts";
import { Tracer, traceId, tracerForCallee, tracerBackend, flush, tracerWithMoreSpans, tracing, noTracer, resetTracer } from "../tracing/tracing.ts";
import { jsonRaw, jsonText, jsonList, jsonStringMember, jsonUnescape } from "./scan.ts";
import { openThread, rememberRouteKey, runInThread, EVAL_CASE_KEY } from "./threads.ts";

export type EvalItem = {
  id: string,
  question: string,
  expected: string,
  expectedTools: string[],
  expectedAgents: string[],
  expectedScopes: string[],
};

export type EvalResult = {
  itemId: string,
  question: string,
  expected: string,
  answer: string,
  traceId: string,
  score: number,
  reason: string,
  calledTools: string[],
  calledAgents: string[],
  missingTools: string[],
  missingAgents: string[],
  usedScopes: string[],
  missingScopes: string[],
  scopeScore: number,
  toolScore: number,
  agentScore: number,
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
  passed: int,
  meanScore: number,
  results: EvalResult[],
  error: string,
};

const PASS_MARK: number = 0.7;

/* A sentinel below any score a judge could mean, so "the score would not read
   as a number" stays distinct from "the score was negative", which clamps. */
const NO_SCORE: number = -1.0e30;

export function evalApiBase(backend: TraceBackend): string {
  if (!hasDatasets(backend)) {
    return "";
  }
  return backend.apiBase;
}

export type DatasetSummary = {
  name: string,
  description: string,
};

/** A case as someone writes it, before the backend has an id for it. */
export type NewCase = {
  dataset: string,
  question: string,
  expected: string,
  expectedTools: string[],
  expectedAgents: string[],
  expectedScopes: string[],
};

export function datasetSummaries(base: string, auth: string): DatasetSummary[] {
  let out: DatasetSummary[] = [];
  if (base == "") {
    return out;
  }
  let res = http.request(base + "/api/public/v2/datasets?limit=100", "GET", "", jsonHeaders(auth));
  if (!res.ok || res.status != 200) {
    return out;
  }
  let rows = jsonList(jsonRaw(res.body, "data"));
  let i: int = 0;
  while (i < rows.length) {
    let name = jsonText(rows[i], "name");
    if (name != "") {
      let one: DatasetSummary = { name: name, description: jsonText(rows[i], "description") };
      out.push(one);
    }
    i = i + 1;
  }
  return out;
}

export function hasDataset(names: DatasetSummary[], wanted: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i].name == wanted) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function createDataset(base: string, auth: string, name: string, description: string): bool {
  if (base == "" || name == "") {
    return false;
  }
  let body = "{\"name\":" + JSON.stringify(name)
    + ",\"description\":" + JSON.stringify(description) + "}";
  let res = http.request(base + "/api/public/v2/datasets", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

export function namesJson(names: string[]): string {
  let out = "[";
  let i: int = 0;
  while (i < names.length) {
    if (i > 0) {
      out = out + ",";
    }
    out = out + JSON.stringify(names[i]);
    i = i + 1;
  }
  return out + "]";
}

/** Writes one case in the shape `datasetItems` reads back: the question under
 *  `input`, and everything the run is expected to reach under `expectedOutput`.
 *  Returns the backend's id for it, "" when the write was refused. */
export function addCase(base: string, auth: string, made: NewCase): string {
  if (base == "" || made.dataset == "" || made.question == "") {
    return "";
  }
  let input = "{\"question\":" + JSON.stringify(made.question) + "}";
  let expected = "{\"answer\":" + JSON.stringify(made.expected)
    + ",\"tools\":" + namesJson(made.expectedTools)
    + ",\"agents\":" + namesJson(made.expectedAgents)
    + ",\"scopes\":" + namesJson(made.expectedScopes) + "}";
  let body = "{\"datasetName\":" + JSON.stringify(made.dataset)
    + ",\"input\":" + input
    + ",\"expectedOutput\":" + expected + "}";
  let res = http.request(base + "/api/public/dataset-items", "POST", body, jsonHeaders(auth));
  if (!res.ok || res.status < 200 || res.status >= 300) {
    return "";
  }
  return jsonText(res.body, "id");
}

/** Rewrites a case in place. Langfuse takes the same document as a new case
 *  with the id filled in, so an edit is a write rather than a patch: every
 *  field is sent, and what is not sent is cleared. */
export function updateCase(base: string, auth: string, id: string, made: NewCase): bool {
  if (base == "" || id == "" || made.dataset == "" || made.question == "") {
    return false;
  }
  let input = "{\"question\":" + JSON.stringify(made.question) + "}";
  let expected = "{\"answer\":" + JSON.stringify(made.expected)
    + ",\"tools\":" + namesJson(made.expectedTools)
    + ",\"agents\":" + namesJson(made.expectedAgents)
    + ",\"scopes\":" + namesJson(made.expectedScopes) + "}";
  let body = "{\"id\":" + JSON.stringify(id)
    + ",\"datasetName\":" + JSON.stringify(made.dataset)
    + ",\"input\":" + input
    + ",\"expectedOutput\":" + expected + "}";
  let res = http.request(base + "/api/public/dataset-items", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

export function deleteCase(base: string, auth: string, id: string): bool {
  if (base == "" || id == "") {
    return false;
  }
  let res = http.request(base + "/api/public/dataset-items/" + id, "DELETE", "", jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

export type ScoreLine = {
  name: string,
  value: number,
  comment: string,
};

/** One case as it was actually run: which trace it left, and what the scorers
 *  said about it afterwards. */
export type RunCase = {
  itemId: string,
  question: string,
  traceId: string,
  at: string,
  latency: number,
  scores: ScoreLine[],
};

export type RunLine = {
  name: string,
  at: string,
  items: int,
};

export type RunDetail = {
  name: string,
  dataset: string,
  at: string,
  cases: RunCase[],
};

export function datasetRuns(base: string, auth: string, dataset: string, limit: int): RunLine[] {
  let out: RunLine[] = [];
  if (base == "" || dataset == "") {
    return out;
  }
  let url = base + "/api/public/datasets/" + dataset + "/runs?limit=" + `${limit}`;
  let res = http.request(url, "GET", "", jsonHeaders(auth));
  if (!res.ok || res.status != 200) {
    return out;
  }
  let rows = jsonList(jsonRaw(res.body, "data"));
  let i: int = 0;
  while (i < rows.length) {
    let name = jsonText(rows[i], "name");
    if (name != "") {
      let one: RunLine = { name: name, at: jsonText(rows[i], "createdAt"), items: 0 };
      out.push(one);
    }
    i = i + 1;
  }
  return out;
}

export function traceFacts(base: string, auth: string, into: RunCase): RunCase {
  if (base == "" || into.traceId == "") {
    return into;
  }
  let res = http.request(base + "/api/public/traces/" + into.traceId, "GET", "", jsonHeaders(auth));
  if (!res.ok || res.status != 200) {
    return into;
  }
  let scores: ScoreLine[] = [];
  let rows = jsonList(jsonRaw(res.body, "scores"));
  let i: int = 0;
  while (i < rows.length) {
    let name = jsonText(rows[i], "name");
    if (name != "") {
      let line: ScoreLine = {
        name: name,
        value: parseFloat(jsonRaw(rows[i], "value")) ?? 0.0,
        comment: jsonText(rows[i], "comment"),
      };
      scores.push(line);
    }
    i = i + 1;
  }
  let out: RunCase = {
    itemId: into.itemId,
    question: into.question,
    traceId: into.traceId,
    at: jsonText(res.body, "timestamp"),
    latency: parseFloat(jsonRaw(res.body, "latency")) ?? 0.0,
    scores: scores,
  };
  return out;
}

/** What a past run did, case by case. The dataset is read alongside it so a
 *  case still reads as its question rather than as an id. */
export function runDetail(base: string, auth: string, dataset: string, runName: string): RunDetail {
  let cases: RunCase[] = [];
  if (base == "" || dataset == "" || runName == "") {
    let nothing: RunDetail = { name: runName, dataset: dataset, at: "", cases: cases };
    return nothing;
  }
  let url = base + "/api/public/datasets/" + dataset + "/runs/" + runName;
  let res = http.request(url, "GET", "", jsonHeaders(auth));
  if (!res.ok || res.status != 200) {
    let missing: RunDetail = { name: runName, dataset: dataset, at: "", cases: cases };
    return missing;
  }

  let asked = datasetItems(base, auth, dataset, 200);
  let rows = jsonList(jsonRaw(res.body, "datasetRunItems"));
  let i: int = 0;
  while (i < rows.length) {
    let itemId = jsonText(rows[i], "datasetItemId");
    let empty: ScoreLine[] = [];
    let one: RunCase = {
      itemId: itemId,
      question: questionOf(asked, itemId),
      traceId: jsonText(rows[i], "traceId"),
      at: jsonText(rows[i], "createdAt"),
      latency: 0.0,
      scores: empty,
    };
    cases.push(traceFacts(base, auth, one));
    i = i + 1;
  }
  let out: RunDetail = {
    name: runName,
    dataset: dataset,
    at: jsonText(res.body, "createdAt"),
    cases: cases,
  };
  return out;
}

/** One past execution of a single case: which run it belonged to, the trace it
 *  left, and what the scorers said. */
export type CaseRun = {
  runName: string,
  at: string,
  traceId: string,
  latency: number,
  scores: ScoreLine[],
};

/** A case's own history, newest first.
 *
 *  Walked run by run rather than read from an index, because the backend keeps
 *  runs and not cases: the question "how has this case been doing" is ours, and
 *  answering it means looking through the runs that contain it. */
export function caseRuns(base: string, auth: string, dataset: string, itemId: string, most: int): CaseRun[] {
  let out: CaseRun[] = [];
  if (base == "" || dataset == "" || itemId == "") {
    return out;
  }
  let runs = datasetRuns(base, auth, dataset, 25);
  let r: int = 0;
  while (r < runs.length && out.length < most) {
    let url = base + "/api/public/datasets/" + dataset + "/runs/" + runs[r].name;
    let res = http.request(url, "GET", "", jsonHeaders(auth));
    if (res.ok && res.status == 200) {
      let rows = jsonList(jsonRaw(res.body, "datasetRunItems"));
      let i: int = 0;
      while (i < rows.length && out.length < most) {
        if (jsonText(rows[i], "datasetItemId") == itemId) {
          let empty: ScoreLine[] = [];
          let one: RunCase = {
            itemId: itemId,
            question: "",
            traceId: jsonText(rows[i], "traceId"),
            at: jsonText(rows[i], "createdAt"),
            latency: 0.0,
            scores: empty,
          };
          let told = traceFacts(base, auth, one);
          let line: CaseRun = {
            runName: runs[r].name,
            at: told.at == "" ? one.at : told.at,
            traceId: told.traceId,
            latency: told.latency,
            scores: told.scores,
          };
          out.push(line);
        }
        i = i + 1;
      }
    }
    r = r + 1;
  }
  return out;
}

export function questionOf(items: EvalItem[], itemId: string): string {
  let i: int = 0;
  while (i < items.length) {
    if (items[i].id == itemId) {
      return items[i].question;
    }
    i = i + 1;
  }
  return "a case that has since been removed";
}

function jsonHeaders(auth: string): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", auth);
  return headers;
}

export function datasetItems(base: string, auth: string, dataset: string, maxItems: int): EvalItem[] {
  let out: EvalItem[] = [];
  if (base == "") {
    return out;
  }
  let page: int = 1;
  while (out.length < maxItems) {
    let url = base + "/api/public/dataset-items?datasetName=" + dataset
      + "&limit=50&page=" + `${page}`;
    let res = http.request(url, "GET", "", jsonHeaders(auth));
    if (!res.ok || res.status != 200) {
      return out;
    }

    let items = jsonList(jsonRaw(res.body, "data"));
    if (items.length == 0) {
      return out;
    }

    let i: int = 0;
    while (i < items.length && out.length < maxItems) {
      let input = jsonRaw(items[i], "input");
      let question = jsonText(input, "question");
      if (question == "") {
        question = input;
      }
      let expectedRaw = jsonRaw(items[i], "expectedOutput");
      let expected = jsonText(expectedRaw, "answer");
      if (expected == "") {
        expected = expectedRaw;
      }

      let item: EvalItem = {
        id: jsonText(items[i], "id"),
        question: question,
        expected: expected,
        expectedTools: namesIn(jsonRaw(expectedRaw, "tools")),
        expectedAgents: namesIn(jsonRaw(expectedRaw, "agents")),
        expectedScopes: namesIn(jsonRaw(expectedRaw, "scopes")),
      };
      if (item.id != "" && item.question != "") {
        out.push(item);
      }
      i = i + 1;
    }

    let pages = jsonRaw(res.body, "totalPages");
    if (pages == "" || `${page}` == pages) {
      return out;
    }
    page = page + 1;
  }
  return out;
}

export function namesIn(array: string): string[] {
  let out: string[] = [];
  if (array == "") {
    return out;
  }
  if (array.startsWith("\"")) {
    out.push(jsonUnescape(array.slice(1, array.length - 1)));
    return out;
  }
  let items = jsonList(array);
  let i: int = 0;
  while (i < items.length) {
    if (items[i].startsWith("\"")) {
      out.push(jsonUnescape(items[i].slice(1, items[i].length - 1)));
    }
    i = i + 1;
  }
  return out;
}

export function missingFrom(expected: string[], actual: string[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < expected.length) {
    if (!hasName(actual, expected[i])) {
      out.push(expected[i]);
    }
    i = i + 1;
  }
  return out;
}

export function reachedScore(expected: string[], actual: string[]): number {
  if (expected.length == 0) {
    return 1.0;
  }
  let hit: int = 0;
  let i: int = 0;
  while (i < expected.length) {
    if (hasName(actual, expected[i])) {
      hit = hit + 1;
    }
    i = i + 1;
  }
  return (hit + 0.0) / (expected.length + 0.0);
}

export function linkRunItem(base: string, auth: string, runName: string, itemId: string, runTraceId: string): bool {
  if (base == "" || runTraceId == "") {
    return false;
  }
  let body = "{\"runName\":" + JSON.stringify(runName)
    + ",\"datasetItemId\":" + JSON.stringify(itemId)
    + ",\"traceId\":" + JSON.stringify(runTraceId) + "}";
  let res = http.request(base + "/api/public/dataset-run-items", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

export function postScore(base: string, auth: string, runTraceId: string, name: string, value: number, comment: string): bool {
  if (base == "" || runTraceId == "") {
    return false;
  }
  let body = "{\"traceId\":" + JSON.stringify(runTraceId)
    + ",\"name\":" + JSON.stringify(name)
    + ",\"value\":" + `${value}`
    + ",\"dataType\":\"NUMERIC\""
    + ",\"comment\":" + JSON.stringify(comment) + "}";
  let res = http.request(base + "/api/public/scores", "POST", body, jsonHeaders(auth));
  return res.ok && res.status >= 200 && res.status < 300;
}

export type Verdict = {
  score: number,
  reason: string,
  ok: bool,
};

export function judgePrompt(question: string, expected: string, answer: string): string {
  return "Question asked:\n" + question
    + "\n\nReference answer:\n" + expected
    + "\n\nAnswer to judge:\n" + answer
    + "\n\nDoes the answer say the same thing as the reference? Wording, order and"
    + " extra detail do not matter; the facts and the numbers do. A missing"
    + " number that the question asked for is a failure. Reply with JSON only:"
    + " {\"score\": <0 to 1>, \"reason\": \"<one sentence>\"}";
}

export function readVerdict(text: string): Verdict {
  let raw = jsonRaw(text, "score");
  if (raw == "") {
    let unusable: Verdict = {
      score: 0.0,
      reason: "the judge did not answer with a score: " + text.slice(0, 120),
      ok: false,
    };
    return unusable;
  }
  let parsed = parseFloat(raw) ?? NO_SCORE;
  if (parsed == NO_SCORE) {
    let unreadable: Verdict = {
      score: 0.0,
      reason: "the judge's score was not a number: " + raw,
      ok: false,
    };
    return unreadable;
  }
  let value: number = parsed;
  if (value < 0.0) {
    value = 0.0;
  }
  if (value > 1.0) {
    value = 1.0;
  }
  let why = jsonStringMember(text, "reason");
  let out: Verdict = { score: value, reason: why.text, ok: true };
  return out;
}

export function judgeAnswer(db: Db, judgeAgentId: string, item: EvalItem, answer: string, master: string): Verdict {
  if (judgeAgentId == "") {
    return compareNumbers(item, answer);
  }
  let asked = runAgentTraced(db, judgeAgentId, judgePrompt(item.question, item.expected, answer), master, judgeTracer());
  if (!asked.ok) {
    let broken: Verdict = {
      score: 0.0,
      reason: "the judge could not run: " + asked.error,
      ok: false,
    };
    return broken;
  }
  return readVerdict(asked.text);
}

export function compareNumbers(item: EvalItem, answer: string): Verdict {
  let wanted = numbersIn(item.expected);
  if (wanted.length == 0) {
    let unscored: Verdict = {
      score: 0.0,
      reason: "no judge configured, and the reference answer has no numbers to compare",
      ok: false,
    };
    return unscored;
  }
  let found: int = 0;
  let i: int = 0;
  while (i < wanted.length) {
    if (answer.indexOf(wanted[i]) >= 0) {
      found = found + 1;
    }
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

export function numbersIn(text: string): string[] {
  let out: string[] = [];
  let current = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    let digit = c >= 48 && c <= 57;
    let inner = current != "" && (text.charAt(i) == "." || text.charAt(i) == ",");
    if (digit || inner) {
      current = current + text.charAt(i);
    } else {
      if (current != "") {
        out.push(trimTrailingPoint(current));
      }
      current = "";
    }
    i = i + 1;
  }
  if (current != "") {
    out.push(trimTrailingPoint(current));
  }
  return out;
}

function trimTrailingPoint(value: string): string {
  let out = value;
  while (out.endsWith(".") || out.endsWith(",")) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

function judgeTracer(): Tracer {
  return noTracer();
}

export function missingReason(kind: string, missing: string[], reached: string[]): string {
  if (missing.length == 0) {
    return "every expected " + kind.slice(0, kind.length - 1) + " was reached (" + reached.join(", ") + ")";
  }
  let saw = "nothing";
  if (reached.length > 0) {
    saw = reached.join(", ");
  }
  return "never reached " + missing.join(", ") + "; the run used " + saw;
}

function noEvals(dataset: string, runName: string, why: string): EvalRun {
  let none: EvalResult[] = [];
  let out: EvalRun = {
    ok: false, dataset: dataset, runName: runName, items: 0, scored: 0,
    passed: 0, meanScore: 0.0, results: none, error: why,
  };
  return out;
}

export type EvalRequest = {
  agentId: string,
  judgeAgentId: string,
  dataset: string,
  runName: string,
  master: string,
  maxItems: int,
  // Who the run is for. An agent whose tools are reached by a person's own
  // grant answers differently for a caller it cannot name, so a case about
  // one of those has to be run as somebody.
  owner: string,
  // One case's id, "" for the first `maxItems` of the set. A caller that wants
  // to watch the cases go by runs them one at a time rather than waiting on
  // the whole set, and this is how it names the one it means.
  onlyItem: string,
};

export function onlyOne(items: EvalItem[], wanted: string): EvalItem[] {
  let out: EvalItem[] = [];
  if (wanted == "") {
    return items;
  }
  let i: int = 0;
  while (i < items.length) {
    if (items[i].id == wanted) {
      out.push(items[i]);
    }
    i = i + 1;
  }
  return out;
}

/* A case runs in a conversation of its own. Outside a thread an agent has no
   artifacts, no workspace, no scripts and nothing schedulable, so an eval of
   anything this deployment offers would score the absence of the tools rather
   than the model. Fresh per case, so one case cannot read another's files. */
export function threadForCase(db: Db, agentId: string, owner: string): string {
  let id = openThread(db, { agentId: agentId, owner: owner, now: `${Date.now()}` });
  if (id == "") {
    return "";
  }
  rememberRouteKey(db, id, EVAL_CASE_KEY);
  return id;
}

export function runEvals(db: Db, request: EvalRequest, tracer: Tracer): EvalRun {
  let agentId = request.agentId;
  let judgeAgentId = request.judgeAgentId;
  let dataset = request.dataset;
  let runName = request.runName;
  let master = request.master;
  let maxItems = request.maxItems;
  let results: EvalResult[] = [];

  if (!tracing(tracer)) {
    return noEvals(dataset, runName, "tracing is not configured, and the cases live in Langfuse");
  }
  let backend = tracerBackend(tracer);
  let base = evalApiBase(backend);
  if (base == "") {
    return noEvals(dataset, runName, "the \"" + backend.name + "\" backend keeps no datasets, so there are no cases to run");
  }
  let auth = backend.authValue;

  let reach = request.onlyItem == "" ? maxItems : 200;
  let items = onlyOne(datasetItems(base, auth, dataset, reach), request.onlyItem);
  if (items.length == 0) {
    if (request.onlyItem != "") {
      return noEvals(dataset, runName, "no case " + request.onlyItem + " in \"" + dataset + "\"");
    }
    return noEvals(dataset, runName, "no cases in dataset \"" + dataset + "\"");
  }

  let total: number = 0.0;
  let scored: int = 0;
  let passed: int = 0;

  let i: int = 0;
  while (i < items.length) {
    let caseTracer = resetTracer(tracer);
    let room = threadForCase(db, agentId, request.owner);
    // Without a room the run still happens, with the remote servers it can
    // reach and nothing of this deployment's own.
    let answered = room == ""
      ? runAgentFor(db, agentId, items[i].question, master, request.owner, caseTracer)
      : runInThread(db, room, items[i].question, master, caseTracer).run;

    let delegations: int = 0;
    let s: int = 0;
    while (s < answered.steps.length) {
      if (answered.steps[s].tool.startsWith("ask_")) {
        delegations = delegations + 1;
      }
      s = s + 1;
    }

    let caseTrace = traceId(caseTracer);

    flush(tracerWithMoreSpans(caseTracer, answered.spans));
    linkRunItem(base, auth, runName, items[i].id, caseTrace);

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
        if (verdict.score >= PASS_MARK) {
          passed = passed + 1;
        }
        postScore(base, auth, caseTrace, "correctness", verdict.score, verdict.reason);
      } else {
        why = verdict.reason;
      }
    }

    let usedScopes: string[] = [];
    let r: int = 0;
    while (r < answered.retrieved.length) {
      if (!hasName(usedScopes, answered.retrieved[r].scope)) {
        usedScopes.push(answered.retrieved[r].scope);
      }
      r = r + 1;
    }
    let missingScopes = missingFrom(items[i].expectedScopes, usedScopes);
    let scopeScore = reachedScore(items[i].expectedScopes, usedScopes);
    if (items[i].expectedScopes.length > 0) {
      postScore(base, auth, caseTrace, "retrieval", scopeScore,
        missingReason("scopes", missingScopes, usedScopes));
    }

    let missingTools = missingFrom(items[i].expectedTools, answered.calledTools);
    let missingAgents = missingFrom(items[i].expectedAgents, answered.calledAgents);
    let toolScore = reachedScore(items[i].expectedTools, answered.calledTools);
    let agentScore = reachedScore(items[i].expectedAgents, answered.calledAgents);

    if (items[i].expectedTools.length > 0) {
      postScore(base, auth, caseTrace, "tool-use", toolScore,
        missingReason("tools", missingTools, answered.calledTools));
    }
    if (items[i].expectedAgents.length > 0) {
      postScore(base, auth, caseTrace, "delegation", agentScore,
        missingReason("agents", missingAgents, answered.calledAgents));
    }

    let result: EvalResult = {
      itemId: items[i].id,
      question: items[i].question,
      expected: items[i].expected,
      answer: answered.text,
      traceId: caseTrace,
      score: score,
      reason: reason,
      calledTools: answered.calledTools,
      calledAgents: answered.calledAgents,
      missingTools: missingTools,
      missingAgents: missingAgents,
      usedScopes: usedScopes,
      missingScopes: missingScopes,
      scopeScore: scopeScore,
      toolScore: toolScore,
      agentScore: agentScore,
      ran: answered.ok,
      error: why,
      delegations: delegations,
      rounds: answered.rounds,
    };
    results.push(result);
    i = i + 1;
  }

  let mean: number = 0.0;
  if (scored > 0) {
    mean = total / scored;
  }
  let out: EvalRun = {
    ok: true, dataset: dataset, runName: runName, items: items.length,
    scored: scored, passed: passed, meanScore: mean, results: results, error: "",
  };
  return out;
}

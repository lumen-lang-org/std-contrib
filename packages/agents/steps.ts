import { Db } from "../plume/driver.ts";
import { cardClaims } from "./toolcards.ts";
import { jsonFind, jsonRaw, jsonText } from "./scan.ts";
import { DbField, DbRepository, DbOrder, field, repository, persist, findById, listOrdered, deleteWhere, dialectType, placeholderAt } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { threadStepRepository } from "./routes/threads/entities/thread-step.entity.ts";
import { threadThoughtRepository } from "./routes/threads/entities/thread-thought.entity.ts";

export type LiveStep = {
  id: string,
  threadId: string,
  seq: int,
  depth: int,
  rotation: int,
  idx: int,
  kind: string,
  name: string,
  target: string,
  args: string,
  startedAt: string,
  endedAt: string,
  millis: int,
  ok: bool,
  result: string,
};

export const ARGS_PREVIEW = 120;

export const RESULT_PREVIEW = 700;

export const RESULT_FOR_CARD = 65536;

export function stepsMapping(): DbRepository {
  return threadStepRepository();
}

export function stepPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("55", "thread steps",
      "CREATE TABLE IF NOT EXISTS thread_steps ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "idx INTEGER NOT NULL, "
      + "kind " + db.textType + " NOT NULL, "
      + "name " + db.textType + " NOT NULL, "
      + "target " + db.textType + " NOT NULL, "
      + "args " + db.textType + " NOT NULL, "
      + "started_at " + db.textType + " NOT NULL, "
      + "ended_at " + db.textType + " NOT NULL, "
      + "ok " + dialectType(db, "bool") + " NOT NULL)"),
    migration("57", "steps carry their rotation",
      "ALTER TABLE thread_steps ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0"),
    migration("58", "steps carry their own duration",
      "ALTER TABLE thread_steps ADD COLUMN millis INTEGER NOT NULL DEFAULT -1"),
    migration("59", "what the model was thinking",
      "CREATE TABLE IF NOT EXISTS thread_thoughts ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "rotation INTEGER NOT NULL, "
      + "text " + db.textType + " NOT NULL, "
      + "created_at " + db.textType + " NOT NULL)"),
    migration("60", "thoughts by round",
      "CREATE INDEX IF NOT EXISTS thoughts_by_round ON thread_thoughts (thread_id, seq, rotation)"),
    migration("62", "a step knows how deep it was made",
      "ALTER TABLE thread_steps ADD COLUMN depth INTEGER NOT NULL DEFAULT 0"),
    migration("63", "a thought knows whose it is",
      "ALTER TABLE thread_thoughts ADD COLUMN depth INTEGER NOT NULL DEFAULT 0"),
    migration("56", "steps by round",
      "CREATE INDEX IF NOT EXISTS steps_by_round ON thread_steps (thread_id, seq, idx)"),
    migration("70", "steps keep a result preview",
      "ALTER TABLE thread_steps ADD COLUMN result " + db.textType + " NOT NULL DEFAULT ''"),
    migration("94", "the answer as it streams",
      "CREATE TABLE IF NOT EXISTS thread_partials ("
      + "thread_id " + db.textType + " PRIMARY KEY, "
      + "seq INTEGER NOT NULL, "
      + "text " + db.textType + " NOT NULL, "
      + "updated_at " + db.textType + " NOT NULL)"),
  ];
  return plan;
}

export type Thought = {
  id: string,
  threadId: string,
  seq: int,
  depth: int,
  rotation: int,
  text: string,
  createdAt: string,
};

export function thoughtsMapping(): DbRepository {
  return threadThoughtRepository();
}

export function recordThought(db: Db, threadId: string, seq: int, depth: int, rotation: int, text: string, now: string): void {
  if (threadId == "" || text == "") {
    return;
  }
  let row: Thought = {
    id: threadId + ":" + `${seq}` + ":d" + `${depth}` + ":r" + `${rotation}`,
    threadId: threadId, seq: seq, depth: depth, rotation: rotation, text: text, createdAt: now,
  };
  persist(db, thoughtsMapping(), JSON.stringify(row));
}

export function thoughtsOfRound(db: Db, threadId: string, seq: int): Thought[] {
  let keys: DbOrder[] = [{ column: "created_at" }, { column: "depth" }, { column: "rotation" }];
  let where = "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2);
  let args: string[] = [threadId, `${seq}`];
  return JSON.parse<Thought[]>(listOrdered(db, thoughtsMapping(), {
    where: where,
    args: args,
    order: keys,
  }));
}

export function thoughtsOfThread(db: Db, threadId: string): Thought[] {
  let keys: DbOrder[] = [{
    column: "seq",
  }, {
    column: "created_at",
  }, {
    column: "depth",
  }, {
    column: "rotation",
  }];
  let args: string[] = [threadId];
  return JSON.parse<Thought[]>(
    listOrdered(db, thoughtsMapping(), {
      where: "thread_id = " + placeholderAt(db, 1),
      args: args,
      order: keys,
    }));
}

export function forgetThoughts(db: Db, threadId: string, seq: int): void {
  let args: string[] = [threadId, `${seq}`];
  deleteWhere(db, thoughtsMapping(),
    "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2), args);
}

export function stepId(threadId: string, seq: int, depth: int, idx: int): string {
  return threadId + ":" + `${seq}` + ":d" + `${depth}` + ":" + `${idx}`;
}

export function argsPreview(args: string): string {
  if (args.length <= ARGS_PREVIEW) {
    return args;
  }
  let cut = ARGS_PREVIEW - 3;
  while (cut > 0 && continuationByte(args.charCodeAt(cut))) {
    cut = cut - 1;
  }
  return args.slice(0, cut) + "...";
}

export function resultPreview(text: string): string {
  if (text.length <= RESULT_PREVIEW) {
    return text;
  }
  let cut = RESULT_PREVIEW - 3;
  while (cut > 0 && continuationByte(text.charCodeAt(cut))) {
    cut = cut - 1;
  }
  return text.slice(0, cut) + "...";
}

export function resultForCard(text: string): string {
  if (text.length <= RESULT_FOR_CARD) {
    return text;
  }
  let cut = RESULT_FOR_CARD - 3;
  while (cut > 0 && continuationByte(text.charCodeAt(cut))) {
    cut = cut - 1;
  }
  return text.slice(0, cut) + "...";
}

function continuationByte(b: int): bool {
  return b >= 128 && b < 192;
}

export const EDIT_KEEP: int = 1500;

function editCut(text: string): string {
  if (text.length <= EDIT_KEEP) {
    return text;
  }
  let cut = EDIT_KEEP;
  while (cut > 0 && continuationByte(text.charCodeAt(cut))) {
    cut = cut - 1;
  }
  return text.slice(0, cut);
}

function lineCount(text: string): int {
  if (text == "") {
    return 0;
  }
  let n: int = 1;
  let i: int = 0;
  while (i < text.length) {
    if (text.charAt(i) == "\n") {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}

export function stepArgs(name: string, args: string): string {
  return stepArgsAt(name, args, 0, "");
}

export function stepArgsAt(name: string, args: string, line: int, changed: string): string {
  if (name == "run_script") {
    let source = jsonText(args, "source");
    let kept = editCut(source);
    let paths = jsonFind(args, "paths") >= 0 ? jsonRaw(args, "paths") : "[]";
    return "{\"language\":" + JSON.stringify(jsonText(args, "language"))
      + ",\"paths\":" + paths
      + ",\"source\":" + JSON.stringify(kept)
      + ",\"cut\":" + (kept.length < source.length ? "true" : "false")
      + ",\"changed\":" + (changed == "" ? "[]" : changed) + "}";
  }
  if (name != "edit_artifact") {
    return argsPreview(args);
  }
  if (jsonFind(args, "old") < 0 || jsonFind(args, "new") < 0) {
    return argsPreview(args);
  }
  let oldText = jsonText(args, "old");
  let newText = jsonText(args, "new");
  let keptOld = editCut(oldText);
  let keptNew = editCut(newText);
  return "{\"path\":" + JSON.stringify(jsonText(args, "path"))
    + ",\"removed\":" + `${lineCount(oldText)}`
    + ",\"added\":" + `${lineCount(newText)}`
    + ",\"line\":" + `${line}`
    + ",\"old\":" + JSON.stringify(keptOld)
    + ",\"new\":" + JSON.stringify(keptNew)
    + ",\"cut\":" + (keptOld.length < oldText.length || keptNew.length < newText.length ? "true" : "false")
    + "}";
}

export type StepStart = {
  threadId: string,
  seq: int,
  depth: int,
  rotation: int,
  idx: int,
  kind: string,
  name: string,
  target: string,
  args: string,
  now: string,
};

export function beginStep(db: Db, s: StepStart): string {
  let id = stepId(s.threadId, s.seq, s.depth, s.idx);
  let row: LiveStep = {
    id: id, threadId: s.threadId, seq: s.seq, depth: s.depth, rotation: s.rotation, idx: s.idx,
    kind: s.kind, name: s.name, target: s.target, args: stepArgs(s.name, s.args),
    startedAt: s.now, endedAt: "", millis: -1, ok: false,
    result: "",
  };
  persist(db, stepsMapping(), JSON.stringify(row));
  return id;
}

export type StepClose = {
  ok: bool,
  endedAt: string,
  millis: int,
  line: int,
  changed: string,
  result: string,
};

export function endStep(db: Db, s: StepStart, ok: bool, endedAt: string, millis: int): void {
  let close: StepClose = {
    ok: ok,
    endedAt: endedAt,
    millis: millis,
    line: 0,
    changed: "",
    result: "",
  };
  endStepAt(db, s, close);
}

export function endStepAt(db: Db, s: StepStart, close: StepClose): void {
  let row: LiveStep = {
    id: stepId(s.threadId, s.seq, s.depth, s.idx), threadId: s.threadId, seq: s.seq,
    depth: s.depth, rotation: s.rotation, idx: s.idx,
    kind: s.kind, name: s.name, target: s.target,
    args: stepArgsAt(s.name, s.args, close.line, close.changed),
    startedAt: s.now, endedAt: close.endedAt, millis: close.millis, ok: close.ok,
    result: cardClaims(db, s.name)
      ? resultForCard(close.result)
      : resultPreview(close.result),
  };
  persist(db, stepsMapping(), JSON.stringify(row));
}

export function rotations(steps: LiveStep[]): int {
  let seen: int = 0;
  let i: int = 0;
  while (i < steps.length) {
    if (steps[i].rotation + 1 > seen) {
      seen = steps[i].rotation + 1;
    }
    i = i + 1;
  }
  return seen;
}

export function stepsOfRound(db: Db, threadId: string, seq: int): LiveStep[] {
  let keys: DbOrder[] = [{ column: "idx" }];
  let where = "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2);
  let args: string[] = [threadId, `${seq}`];
  return JSON.parse<LiveStep[]>(listOrdered(db, stepsMapping(), {
    where: where,
    args: args,
    order: keys,
  }));
}

export function roundRunning(steps: LiveStep[]): bool {
  let i: int = 0;
  while (i < steps.length) {
    if (steps[i].endedAt == "") {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function stepMillis(s: LiveStep): int {
  return s.millis;
}

export function latestRound(db: Db, threadId: string): int {
  let keys: DbOrder[] = [{ column: "seq", direction: "desc" }];
  let args: string[] = [threadId];
  let stepped = JSON.parse<LiveStep[]>(
    listOrdered(db, stepsMapping(), {
      where: "thread_id = " + placeholderAt(db, 1),
      args: args,
      order: keys,
    }));
  let thought = JSON.parse<Thought[]>(
    listOrdered(db, thoughtsMapping(), {
      where: "thread_id = " + placeholderAt(db, 1),
      args: args,
      order: keys,
    }));
  let best: int = -1;
  if (stepped.length > 0) {
    best = stepped[0].seq;
  }
  if (thought.length > 0 && thought[0].seq > best) {
    best = thought[0].seq;
  }
  return best;
}


export function forgetRound(db: Db, threadId: string, seq: int): void {
  let args: string[] = [threadId, `${seq}`];
  deleteWhere(db, stepsMapping(),
    "thread_id = " + placeholderAt(db, 1) + " AND seq = " + placeholderAt(db, 2), args);
}

export function stepsOfThread(db: Db, threadId: string): LiveStep[] {
  let keys: DbOrder[] = [{
    column: "seq",
  }, {
    column: "started_at",
  }, {
    column: "depth",
  }, {
    column: "idx",
  }];
  let args: string[] = [threadId];
  return JSON.parse<LiveStep[]>(
    listOrdered(db, stepsMapping(), {
      where: "thread_id = " + placeholderAt(db, 1),
      args: args,
      order: keys,
    }));
}

export function forgetSteps(db: Db, threadId: string): void {
  let args: string[] = [threadId];
  deleteWhere(db, stepsMapping(), "thread_id = " + placeholderAt(db, 1), args);
}


type PartialRow = {
  id: string,
  seq: int,
  text: string,
  updatedAt: string,
};

function partialsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "thread_id", "text"),
    field("seq", "seq", "int"),
    field("text", "text", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "thread_partials", idField: "id", idColumn: "thread_id", fields: fs });
}

export function clearPartial(db: Db, threadId: string, now: string): void {
  if (threadId == "") {
    return;
  }
  let row: PartialRow = { id: threadId, seq: -1, text: "", updatedAt: now };
  persist(db, partialsMapping(), JSON.stringify(row));
}

export function recordPartial(db: Db, threadId: string, seq: int, text: string, now: string): void {
  if (threadId == "" || text == "") {
    return;
  }
  let row: PartialRow = { id: threadId, seq: seq, text: text, updatedAt: now };
  persist(db, partialsMapping(), JSON.stringify(row));
}

export function partialOf(db: Db, threadId: string, seq: int): string {
  let held = findById(db, partialsMapping(), threadId);
  if (held == "") {
    return "";
  }
  let row: PartialRow = JSON.parse<PartialRow>(held);
  if (seq >= 0 && row.seq != seq) {
    return "";
  }
  return row.text;
}

// What one owner has used.
//
//   let used = ownerUsage(db, "u-alice");
//   usageJson(used)   // {"owner":"u-alice","bytes":"12288",...}
//
// Generic accounting, and deliberately nothing more: no plan, no quota, no
// price. The engine enforces the same limits for everyone (caps.ts); who is
// allowed how much is the control plane's question, and this is the answer it
// reads to ask it (GATEWAY.md).
//
// A reporting module rather than a function on each table's own file, because
// every number here is a sum across tables that do not otherwise know about
// each other — artifact bytes hang off a thread, tokens hang off a run that
// may have no thread at all — and one place that owns "what has this tenant
// used" beats three that each own a third of it.
//
//   cd packages/agents && lumen test usage.test.ts

import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";

// One owner's consumption, every number a digit string.
//
// Text and not `int`, all the way to the JSON: an int here is i32, and 2.1
// billion tokens is a month for one busy tenant — the counter would wrap and
// the bill would be wrong in the direction nobody notices. The database sums
// them in a wider integer than this language has, so the sum is carried as the
// digits it came back as and never parsed.
export type OwnerUsage = {
  owner: string,
  // Every byte the owner's artifacts hold, across every version — versions are
  // append-only, so an edited artifact keeps costing what its old bodies cost.
  //
  // Artifacts only. Workspace files are storage too and are not counted:
  // `workspace_files` has no byte column, so summing it would mean asking SQL
  // for a length, which counts characters rather than bytes in both dialects
  // and would quietly under-report every non-ASCII upload. A number that is
  // exact and partial beats one that is complete and wrong; the column is a
  // migration for the day the difference matters.
  bytes: string,
  inputTokens: string,
  outputTokens: string,
};

// The sums, or zeros. A database that cannot answer reads as zero rather than
// as an error: this is a reporting route, and a control plane that sees a
// missing tenant does less harm than one that sees a 500 and retries forever.
export function ownerUsage(db: Db, owner: string): OwnerUsage {
  let used: OwnerUsage = {
    owner: owner,
    bytes: artifactBytes(db, owner),
    inputTokens: "0",
    outputTokens: "0",
  };
  let sql = "SELECT SUM(input_tokens), SUM(output_tokens) FROM runs WHERE owner = " + placeholderAt(db, 1);
  if (!db.query(sql, [owner]) || db.rows() == 0) { return used; }
  let counted: OwnerUsage = {
    owner: owner,
    bytes: used.bytes,
    inputTokens: digitsOrZero(db.value(0, 0)),
    outputTokens: digitsOrZero(db.value(0, 1)),
  };
  return counted;
}

// Through the thread, because that is where ownership lives: an artifact
// belongs to a conversation and a conversation belongs to a tag. Stamping the
// tag on the artifact row too would be a second copy of one fact, and the copy
// is the one that goes stale.
function artifactBytes(db: Db, owner: string): string {
  let sql = "SELECT SUM(artifact_versions.bytes) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " JOIN threads ON threads.id = artifacts.thread_id"
    + " WHERE threads.owner = " + placeholderAt(db, 1);
  if (!db.query(sql, [owner]) || db.rows() == 0) { return "0"; }
  return digitsOrZero(db.value(0, 0));
}

// How many runs an owner has filed since a moment — the guest gate's question,
// asked just before a send is allowed to spend a provider call (api.ts).
//
// `since` is epoch-millis digit text, the exact format `runs.created_at`
// holds (runlog.ts): both sides are 13-digit strings until the year 2286, so
// the text comparison the database does is the numeric one. Failed runs count
// too — they spent a provider call, and a quota that only counts successes is
// an invitation to spend eleven failures.
//
// Served by the `runs_by_owner` index (runlog.ts, 86.3); without it this is a
// scan of every tenant's runs on every guest send.
export function runsSince(db: Db, owner: string, since: string): int {
  let sql = "SELECT COUNT(*) FROM runs WHERE owner = " + placeholderAt(db, 1)
    + " AND created_at >= " + placeholderAt(db, 2);
  if (!db.query(sql, [owner, since]) || db.rows() == 0) { return 0; }
  return parseInt(digitsOrZero(db.value(0, 0)), 10) ?? 0;
}

// One UTC day of milliseconds. The guest window is the calendar UTC day — it
// resets at a moment the reply can name honestly — not a rolling 24 hours.
const DAY_MILLIS: number = 86400000;

// The start of the UTC day `now` falls in, as the same epoch-millis digit
// text `runs.created_at` holds — what `runsSince` takes as its cutoff. The
// epoch is a UTC midnight, so the remainder into the day is the one subtraction.
export function utcDayStartText(now: number): string {
  return `${now - (now % DAY_MILLIS)}`;
}

// Whole seconds until the window resets — a Retry-After value. Rounded up:
// telling a client to come back a second early re-earns the same 429.
export function secondsToUtcMidnight(now: number): int {
  let start = now - (now % DAY_MILLIS);
  let wait = Math.floor((start + DAY_MILLIS - now) / 1000) + 1;
  return parseInt(`${wait}`, 10) ?? 0;
}

// The next UTC midnight after `now`, as an ISO instant — the `resetsAt` a
// client shows a person. Always a midnight, so only the date is computed:
// days-since-epoch to a civil date by integer math (the standard
// era/day-of-era conversion), because this runtime has `Date.now()` and no
// calendar.
export function nextUtcMidnightIso(now: number): string {
  let days = parseInt(`${(now - (now % DAY_MILLIS) + DAY_MILLIS) / DAY_MILLIS}`, 10) ?? 0;
  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) { y = y + 1; }
  return `${y}` + "-" + pad2(m) + "-" + pad2(d) + "T00:00:00Z";
}

function pad2(n: int): string {
  if (n < 10) { return "0" + `${n}`; }
  return `${n}`;
}

// A sum as the database gave it, or "0". SUM over no rows is NULL, which
// arrives as empty text; anything else that is not a plain number would be
// interpolated straight into a JSON reply, so it is refused here rather than
// where a client's parser finds it.
function digitsOrZero(said: string): string {
  if (said == "") { return "0"; }
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 48 || c > 57) { return "0"; }
    i = i + 1;
  }
  return said;
}

// The reply. The counts go out unquoted — they are numbers to whoever is
// adding them up, and a client that has to strip quotes before arithmetic will
// eventually forget to.
export function usageJson(used: OwnerUsage): string {
  return "{\"owner\":" + JSON.stringify(used.owner)
    + ",\"bytes\":" + used.bytes
    + ",\"inputTokens\":" + used.inputTokens
    + ",\"outputTokens\":" + used.outputTokens + "}";
}

/* What somebody says about the product, from the page they were on.
 *
 * Kept here rather than mailed or posted to a tracker: it is the deployment's
 * own record, an operator reads it in the console, and it never leaves the
 * box. Three things ride along with the words because they are what make a
 * report actionable and what nobody remembers to type — where they were, who
 * they are, and optionally what the page looked like.
 *
 * Signed in only. Feedback from nobody is a suggestion box on a public street:
 * there is no one to ask what they meant, and no cost to filling it.
 */

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, executeWith, field, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export type FeedbackRow = {
  id: string,
  owner: string,
  /** What they wrote. The whole of the report. */
  said: string,
  /** The page it was sent from, which is the one thing a reader always wants
   *  and a writer never includes. */
  url: string,
  /** A PNG data URI, when they chose to send one. Empty otherwise: the choice
   *  is theirs every time and is never remembered as a preference. */
  shot: string,
  createdAt: string,
};

export function feedbackMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("said", "said", "text"),
    field("url", "url", "text"),
    field("shot", "shot", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "feedback", idField: "id", idColumn: "id", fields: fs });
}

export function feedbackPlan(db: Db): Migration[] {
  return [
    migration("140", "what people say about the product",
      createTableSql(db, feedbackMapping())),
    migration("141", "read newest first, and counted per person per day",
      "CREATE INDEX IF NOT EXISTS feedback_by_owner ON feedback (owner, created_at)"),
  ];
}

/** The most one account may send in a day, or 0 for no limit — which is the
 *  default: somebody with something to say should not be counting. Set
 *  AGENTS_FEEDBACK_PER_OWNER_DAY if a deployment ever needs the brake. */
export function feedbackPerOwnerDay(): int {
  let said = (process.env("AGENTS_FEEDBACK_PER_OWNER_DAY") ?? "").trim();
  if (said == "") {
    return 0;
  }
  let n = parseInt(said, 10) ?? 0;
  return n < 0 ? 0 : n;
}

/** The most of a screenshot this will store. A PNG data URI of a viewport is
 *  a few hundred kilobytes; past this it is a page somebody scrolled for a
 *  minute and the row stops being worth keeping. */
const SHOT_MAX: int = 4000000;

const SAID_MAX: int = 4000;

function dayBegan(nowMs: number): number {
  let day: number = 86400000.0;
  return nowMs - (nowMs % day);
}

/** How many this owner has sent today. */
export function feedbackToday(db: Db, owner: string, nowMs: number): int {
  let sql = "SELECT COUNT(*) FROM feedback WHERE owner = " + placeholderAt(db, 1)
    + " AND created_at >= " + placeholderAt(db, 2);
  if (!db.query(sql, [owner, `${dayBegan(nowMs)}`])) {
    return -1;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseInt(db.value(0, 0), 10) ?? 0;
}

export type FeedbackAsk = {
  owner: string,
  said: string,
  url: string,
  shot: string,
  nowMs: number,
};

export type FeedbackSent = {
  ok: bool,
  fault: string,
  /** What is left of today's allowance after this one. */
  left: int,
};

function refused(why: string, left: int): FeedbackSent {
  let out: FeedbackSent = { ok: false, fault: why, left: left };
  return out;
}

export function sendFeedback(db: Db, ask: FeedbackAsk): FeedbackSent {
  if (ask.owner == "") {
    return refused("sign in to send feedback — an operator has to be able to ask what you meant", 0);
  }
  let said = ask.said.trim();
  if (said == "") {
    return refused("say what you want to tell us", 0);
  }
  if (said.length > SAID_MAX) {
    return refused("that is " + `${said.length}` + " characters, and " + `${SAID_MAX}`
      + " is the most one report may be", 0);
  }
  let shot = ask.shot.length > SHOT_MAX ? "" : ask.shot;

  let allowed = feedbackPerOwnerDay();
  let already: int = 0;
  if (allowed > 0) {
    already = feedbackToday(db, ask.owner, ask.nowMs);
    if (already < 0) {
      return refused("today's count could not be read, so this was not sent", 0);
    }
    if (already >= allowed) {
      return refused("that is " + `${already}` + " reports today, and " + `${allowed}`
        + " is the most one account may send. It starts again at midnight UTC", 0);
    }
  }

  let row: FeedbackRow = {
    id: crypto.randomUUID(), owner: ask.owner, said: said, url: ask.url.trim(),
    shot: shot, createdAt: `${ask.nowMs}`,
  };
  let wrote = persist(db, feedbackMapping(), JSON.stringify(row));
  if (!wrote.ok) {
    return refused(wrote.error, allowed - already);
  }
  // -1 is "no limit", which the console reads as nothing to show.
  let done: FeedbackSent = {
    ok: true, fault: "", left: allowed > 0 ? allowed - already - 1 : -1,
  };
  return done;
}

/** Newest first, for the operator's screen. */
export function feedbackListing(db: Db, limit: int): string {
  let keys: DbOrder[] = [{ column: "created_at", direction: "desc" }];
  return listOrdered(db, feedbackMapping(), { order: keys, limit: limit, offset: 0 });
}

export function forgetFeedback(db: Db, id: string): string {
  let gone = executeWith(db, "DELETE FROM feedback WHERE id = " + placeholderAt(db, 1), [id]);
  if (gone.ok) {
    return "";
  }
  return gone.error;
}

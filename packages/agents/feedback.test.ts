import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, createTableSql, execute } from "../plume/plume.ts";
import { FeedbackAsk, FeedbackRow, feedbackListing, feedbackMapping, feedbackPerOwnerDay, feedbackToday, forgetFeedback, sendFeedback } from "./feedback.ts";

let database: Db = sqlite();
let opened = false;

function fresh(): Db {
  if (!opened) {
    let cfg: DbConfig = { filename: "/tmp/agents_feedback_test.db" };
    connectDatabase(database, cfg);
    opened = true;
  }
  execute(database, "DROP TABLE IF EXISTS feedback");
  execute(database, createTableSql(database, feedbackMapping()));
  return database;
}

const NOW: number = 1787100000000.0;

function ask(owner: string, said: string): FeedbackAsk {
  let out: FeedbackAsk = {
    owner: owner, said: said, url: "https://joule.sh/c/abc", shot: "", nowMs: NOW,
  };
  return out;
}

test("nobody signed in sends nothing, and is told why", () => {
  let db = fresh();
  let out = sendFeedback(db, ask("", "the button is in the wrong place"));
  expect(!out.ok);
  expect(out.fault.indexOf("sign in") >= 0);
});

test("an empty report is refused before it is stored", () => {
  let db = fresh();
  expect(!sendFeedback(db, ask("u-ann", "   ")).ok);
  expect(feedbackToday(db, "u-ann", NOW) == 0);
});

test("what was said is kept with where it was said from", () => {
  let db = fresh();
  let out = sendFeedback(db, ask("u-ann", "the search box loses my query"));
  expect(out.ok);
  let rows: FeedbackRow[] = JSON.parse<FeedbackRow[]>(feedbackListing(db, 10));
  expect(rows.length == 1);
  expect(rows[0].said == "the search box loses my query");
  expect(rows[0].url == "https://joule.sh/c/abc");
  expect(rows[0].owner == "u-ann");
  // No screenshot unless one was offered.
  expect(rows[0].shot == "");
});

test("five a day, counted per person, and the sixth is refused with the number in it", () => {
  let db = fresh();
  let n: int = 0;
  while (n < feedbackPerOwnerDay()) {
    expect(sendFeedback(db, ask("u-ann", "report " + `${n}`)).ok);
    n = n + 1;
  }
  let sixth = sendFeedback(db, ask("u-ann", "one more"));
  expect(!sixth.ok);
  expect(sixth.fault.indexOf("most one account may send") > 0);
  // Somebody else's day is their own.
  expect(sendFeedback(db, ask("u-bob", "mine still works")).ok);
  expect(feedbackToday(db, "u-ann", NOW) == feedbackPerOwnerDay());
  expect(feedbackToday(db, "u-bob", NOW) == 1);
});

test("yesterday's reports do not spend today's allowance", () => {
  let db = fresh();
  let day: number = 86400000.0;
  let yesterday: FeedbackAsk = {
    owner: "u-ann", said: "old", url: "", shot: "", nowMs: NOW - day,
  };
  expect(sendFeedback(db, yesterday).ok);
  expect(feedbackToday(db, "u-ann", NOW) == 0);
  expect(sendFeedback(db, ask("u-ann", "new")).ok);
});

test("what is left is counted down, so a button can say so", () => {
  let db = fresh();
  expect(sendFeedback(db, ask("u-ann", "one")).left == feedbackPerOwnerDay() - 1);
  expect(sendFeedback(db, ask("u-ann", "two")).left == feedbackPerOwnerDay() - 2);
});

test("an operator can forget one", () => {
  let db = fresh();
  expect(sendFeedback(db, ask("u-ann", "delete me")).ok);
  let rows: FeedbackRow[] = JSON.parse<FeedbackRow[]>(feedbackListing(db, 10));
  expect(forgetFeedback(db, rows[0].id) == "");
  expect(feedbackListing(db, 10) == "[]");
});

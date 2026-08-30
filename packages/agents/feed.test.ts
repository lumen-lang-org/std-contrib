import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { FEED_ARTIFACTS, FEED_ROUND, TURN_DONE, TURN_RUNNING, acceptTurn, feedHead, feedPlan, feedSince, feedStamp, noteFeed, latestTurnOf, runningRoundOf, settleTurn, turnRunning, turnStateOf } from "./feed.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_feed_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS thread_feed");
  execute(database, "DROP TABLE IF EXISTS thread_turn_state");
  migrate(database, feedPlan(database));
}

test("a stamp is padded to a fixed width, so text order is time order", () => {
  fresh();
  expect(feedStamp("1787000000000").length == 13);
  expect(feedStamp("42").length == 13);
  expect(feedStamp("42") < feedStamp("1787000000000"));
});

test("a note is one row per thread and kind, overwritten as it changes", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t1", FEED_ROUND, 0, "1001");
  noteFeed(database, "t1", FEED_ROUND, 0, "1002");
  let all = feedSince(database, "");
  expect(all.length == 1);
  expect(all[0].bumped == feedStamp("1002"));
});

test("two kinds on one thread are two notes", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t1", FEED_ARTIFACTS, 0, "1001");
  expect(feedSince(database, "").length == 2);
});

test("a subscriber is told only what changed at or after its cursor", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t2", FEED_ROUND, 0, "2000");
  let later = feedSince(database, feedStamp("1500"));
  expect(later.length == 1);
  expect(later[0].threadId == "t2");
});

test("the cursor itself is included, so a same-millisecond note is never lost", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t2", FEED_ROUND, 0, "1000");
  expect(feedSince(database, feedStamp("1000")).length == 2);
});

test("what arrives is in the order it was written", () => {
  fresh();
  noteFeed(database, "t3", FEED_ROUND, 0, "3000");
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t2", FEED_ROUND, 0, "2000");
  let all = feedSince(database, "");
  expect(all.length == 3);
  expect(all[0].threadId == "t1");
  expect(all[2].threadId == "t3");
});

test("an empty cursor is a first connection and gets everything", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t2", FEED_ROUND, 0, "2000");
  expect(feedSince(database, "").length == 2);
});

test("the head is where a subscriber that wants nothing replayed starts", () => {
  fresh();
  expect(feedHead(database) == "");
  noteFeed(database, "t1", FEED_ROUND, 0, "1000");
  noteFeed(database, "t2", FEED_ROUND, 0, "4000");
  expect(feedHead(database) == feedStamp("4000"));
});

test("a note keeps the round it is about, so a reader knows which turn moved", () => {
  fresh();
  noteFeed(database, "t1", FEED_ROUND, 7, "1000");
  expect(feedSince(database, "")[0].seq == 7);
  expect(feedSince(database, "")[0].kind == FEED_ROUND);
});

test("an accepted turn is running before a single step exists", () => {
  fresh();
  acceptTurn(database, "t1", 4, "1000");
  expect(turnRunning(database, "t1", 4));
  expect(turnStateOf(database, "t1", 4).state == TURN_RUNNING);
  expect(turnStateOf(database, "t1", 4).body == "");
});

test("accepting a turn is itself a change the feed carries", () => {
  fresh();
  acceptTurn(database, "t1", 4, "1000");
  let notes = feedSince(database, "");
  expect(notes.length == 1);
  expect(notes[0].kind == FEED_ROUND);
  expect(notes[0].seq == 4);
});

test("a settled turn keeps its answer, so a dropped reader can still read it", () => {
  fresh();
  acceptTurn(database, "t1", 4, "1000");
  settleTurn(database, "t1", 4, "{\"ok\":true}", "2000");
  let state = turnStateOf(database, "t1", 4);
  expect(state.state == TURN_DONE);
  expect(state.body == "{\"ok\":true}");
  expect(state.startedAt == "1000");
  expect(state.endedAt == "2000");
  expect(!turnRunning(database, "t1", 4));
});

test("settling says both the round and the files changed", () => {
  fresh();
  settleTurn(database, "t1", 4, "{}", "2000");
  expect(feedSince(database, "").length == 2);
});

test("a turn nobody accepted has no state at all", () => {
  fresh();
  expect(turnStateOf(database, "t1", 9).state == "");
  expect(turnStateOf(database, "t1", -1).state == "");
  expect(!turnRunning(database, "t1", 9));
});

test("a nameless thread or kind writes nothing", () => {
  fresh();
  noteFeed(database, "", FEED_ROUND, 0, "1000");
  noteFeed(database, "t1", "", 0, "1000");
  expect(feedSince(database, "").length == 0);
});

test("a turn that took no steps still names the round it was", () => {
  fresh();
  expect(latestTurnOf(database, "t1") == -1);
  acceptTurn(database, "t1", 0, "1000");
  settleTurn(database, "t1", 0, "{}", "2000");
  expect(latestTurnOf(database, "t1") == 0);
  expect(runningRoundOf(database, "t1") == -1);
});

test("the running round is the one a reader should be shown", () => {
  fresh();
  acceptTurn(database, "t1", 0, "1000");
  settleTurn(database, "t1", 0, "{}", "2000");
  acceptTurn(database, "t1", 1, "3000");
  expect(runningRoundOf(database, "t1") == 1);
  expect(latestTurnOf(database, "t1") == 1);
});

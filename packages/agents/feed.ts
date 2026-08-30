import { Db } from "../plume/driver.ts";
import { DbOrder, DbRepository, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { threadFeedRepository } from "./routes/conversations/threads/entities/thread-feed.entity.ts";
import { threadTurnStateRepository } from "./routes/conversations/threads/entities/thread-turn-state.entity.ts";

export const FEED_ROUND: string = "round";
export const FEED_ARTIFACTS: string = "artifacts";

export const TURN_RUNNING: string = "running";
export const TURN_DONE: string = "done";

export const FEED_PORT: int = 8101;
export const FEED_TICK_MS: int = 150;
export const FEED_BEAT_MS: int = 15000;
export const FEED_LIFE_MS: int = 600000;
export const FEED_STAMP_WIDTH: int = 13;

export type FeedNote = {
  id: string,
  threadId: string,
  kind: string,
  seq: int,
  bumped: string,
};

export type TurnState = {
  id: string,
  threadId: string,
  seq: int,
  state: string,
  body: string,
  startedAt: string,
  endedAt: string,
};

export function feedMapping(): DbRepository {
  return threadFeedRepository();
}

export function turnStateMapping(): DbRepository {
  return threadTurnStateRepository();
}

export function feedPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("144", "a thread says when it changed",
      "CREATE TABLE IF NOT EXISTS thread_feed ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "kind " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "bumped " + db.textType + " NOT NULL)"),
    migration("145", "the feed is read in the order it was written",
      "CREATE INDEX IF NOT EXISTS feed_by_stamp ON thread_feed (bumped)"),
    migration("146", "a turn says what it is doing and what it produced",
      "CREATE TABLE IF NOT EXISTS thread_turn_state ("
      + "id " + db.textType + " PRIMARY KEY, "
      + "thread_id " + db.textType + " NOT NULL, "
      + "seq INTEGER NOT NULL, "
      + "state " + db.textType + " NOT NULL, "
      + "body " + db.textType + " NOT NULL, "
      + "started_at " + db.textType + " NOT NULL, "
      + "ended_at " + db.textType + " NOT NULL)"),
    migration("147", "a turn is found by its round",
      "CREATE INDEX IF NOT EXISTS turn_state_by_round ON thread_turn_state (thread_id, seq)"),
  ];
  return plan;
}

export function feedStamp(at: string): string {
  let text = at.trim();
  while (text.length < FEED_STAMP_WIDTH) {
    text = "0" + text;
  }
  return text;
}

export function noteFeed(db: Db, threadId: string, kind: string, seq: int, at: string): void {
  if (threadId == "" || kind == "") {
    return;
  }
  let row: FeedNote = {
    id: threadId + ":" + kind,
    threadId: threadId,
    kind: kind,
    seq: seq,
    bumped: feedStamp(at),
  };
  persist(db, feedMapping(), JSON.stringify(row));
}

export function feedSince(db: Db, cursor: string): FeedNote[] {
  let keys: DbOrder[] = [{ column: "bumped" }];
  if (cursor == "") {
    return JSON.parse<FeedNote[]>(listOrdered(db, feedMapping(), { order: keys }));
  }
  let args: string[] = [cursor];
  return JSON.parse<FeedNote[]>(listOrdered(db, feedMapping(), {
    where: "bumped >= " + placeholderAt(db, 1),
    args: args,
    order: keys,
  }));
}

export function feedHead(db: Db): string {
  let keys: DbOrder[] = [{ column: "bumped", direction: "desc" }];
  let rows = JSON.parse<FeedNote[]>(listOrdered(db, feedMapping(), { order: keys }));
  if (rows.length == 0) {
    return "";
  }
  return rows[0].bumped;
}

export function turnId(threadId: string, seq: int): string {
  return threadId + ":" + `${seq}`;
}

export function noTurnState(threadId: string, seq: int): TurnState {
  let none: TurnState = {
    id: "", threadId: threadId, seq: seq, state: "", body: "",
    startedAt: "", endedAt: "",
  };
  return none;
}

export function turnStateOf(db: Db, threadId: string, seq: int): TurnState {
  if (threadId == "" || seq < 0) {
    return noTurnState(threadId, seq);
  }
  let held = findById(db, turnStateMapping(), turnId(threadId, seq));
  if (held == "" || held == "{}") {
    return noTurnState(threadId, seq);
  }
  return JSON.parse<TurnState>(held);
}

export function acceptTurn(db: Db, threadId: string, seq: int, now: string): void {
  let row: TurnState = {
    id: turnId(threadId, seq), threadId: threadId, seq: seq,
    state: TURN_RUNNING, body: "", startedAt: now, endedAt: "",
  };
  persist(db, turnStateMapping(), JSON.stringify(row));
  noteFeed(db, threadId, FEED_ROUND, seq, now);
}

export function settleTurn(db: Db, threadId: string, seq: int, body: string, now: string): void {
  let was = turnStateOf(db, threadId, seq);
  let started = was.startedAt == "" ? now : was.startedAt;
  let row: TurnState = {
    id: turnId(threadId, seq), threadId: threadId, seq: seq,
    state: TURN_DONE, body: body, startedAt: started, endedAt: now,
  };
  persist(db, turnStateMapping(), JSON.stringify(row));
  noteFeed(db, threadId, FEED_ROUND, seq, now);
  noteFeed(db, threadId, FEED_ARTIFACTS, seq, now);
}

export function turnRunning(db: Db, threadId: string, seq: int): bool {
  return turnStateOf(db, threadId, seq).state == TURN_RUNNING;
}

export function latestTurnOf(db: Db, threadId: string): int {
  if (threadId == "") {
    return -1;
  }
  let keys: DbOrder[] = [{ column: "seq", direction: "desc" }];
  let args: string[] = [threadId];
  let rows = JSON.parse<TurnState[]>(listOrdered(db, turnStateMapping(), {
    where: "thread_id = " + placeholderAt(db, 1),
    args: args,
    order: keys,
  }));
  if (rows.length == 0) {
    return -1;
  }
  return rows[0].seq;
}

export function runningRoundOf(db: Db, threadId: string): int {
  if (threadId == "") {
    return -1;
  }
  let keys: DbOrder[] = [{ column: "seq", direction: "desc" }];
  let args: string[] = [threadId, TURN_RUNNING];
  let rows = JSON.parse<TurnState[]>(listOrdered(db, turnStateMapping(), {
    where: "thread_id = " + placeholderAt(db, 1) + " AND state = " + placeholderAt(db, 2),
    args: args,
    order: keys,
  }));
  if (rows.length == 0) {
    return -1;
  }
  return rows[0].seq;
}

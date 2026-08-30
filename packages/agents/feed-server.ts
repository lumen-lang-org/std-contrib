import { Db } from "../plume/driver.ts";
import { EventStream, pushComment, pushEventWithId, serveEvents } from "../sse/sse.ts";
import { openDatabase } from "./database.ts";
import { FEED_BEAT_MS, FEED_LIFE_MS, FEED_ROUND, FEED_TICK_MS, FeedNote, feedHead, feedSince } from "./feed.ts";
import { roundOf } from "./routes/conversations/threads/thread.utils.ts";

export function feedPresented(authorization: string, token: string): bool {
  if (token == "") {
    return true;
  }
  let prefix = "Bearer ";
  if (authorization.length <= prefix.length) {
    return false;
  }
  if (authorization.substring(0, prefix.length).toLowerCase() != prefix.toLowerCase()) {
    return false;
  }
  return authorization.substring(prefix.length, authorization.length).trim() == token;
}

export function feedPayload(db: Db, note: FeedNote): string {
  if (note.kind == FEED_ROUND) {
    return "{\"threadId\":" + JSON.stringify(note.threadId)
      + ",\"round\":" + JSON.stringify(roundOf(db, note.threadId, "")) + "}";
  }
  return "{\"threadId\":" + JSON.stringify(note.threadId) + "}";
}

export function alreadySent(sent: string[], at: string): bool {
  let i: int = 0;
  while (i < sent.length) {
    if (sent[i] == at) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function serveFeed(port: int, token: string): void {
  serveEvents(port, (stream: EventStream) => {
    feedStream(stream, token);
  });
}

function feedStream(stream: EventStream, token: string): void {
  if (!feedPresented(stream.authorization, token)) {
    pushEventWithId(stream, { id: "", name: "refused",
      data: "{\"error\":\"a bearer token is required\"}" });
    return;
  }
  let db = openDatabase();
  let cursor = stream.lastEventId.trim();
  let replaying = cursor != "";
  if (!replaying) {
    cursor = feedHead(db);
  }
  let sent: string[] = [];
  pushEventWithId(stream, { id: cursor, name: "hello",
    data: "{\"cursor\":" + JSON.stringify(cursor)
      + ",\"replaying\":" + (replaying ? "true" : "false") + "}" });

  let lived: int = 0;
  let quiet: int = 0;
  while (lived < FEED_LIFE_MS) {
    let notes: FeedNote[] = [];
    try {
      notes = feedSince(db, cursor);
    }
    catch (e) {
      console.error("feed: the notices could not be read — " + e.message);
    }
    let i: int = 0;
    while (i < notes.length) {
      let note = notes[i];
      i = i + 1;
      if (note.bumped == cursor && alreadySent(sent, note.id)) {
        continue;
      }
      if (note.bumped != cursor) {
        cursor = note.bumped;
        let empty: string[] = [];
        sent = empty;
      }
      sent.push(note.id);
      try {
        pushEventWithId(stream, { id: note.bumped, name: note.kind,
          data: feedPayload(db, note) });
      }
      catch (e) {
        console.error("feed: a notice could not be sent — " + e.message);
      }
      quiet = 0;
    }
    if (quiet >= FEED_BEAT_MS) {
      pushComment(stream, "beat");
      quiet = 0;
    }
    process.sleep(FEED_TICK_MS);
    lived = lived + FEED_TICK_MS;
    quiet = quiet + FEED_TICK_MS;
  }
}

export function feedLoop(port: int, token: string): int {
  try {
    console.log(`the live feed is on ${port}`);
    serveFeed(port, token);
  }
  catch (e) {
    console.error("the live feed stopped: " + e.message);
  }
  return 0;
}

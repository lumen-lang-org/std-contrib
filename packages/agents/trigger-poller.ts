// One bot's poller: hold the long poll, write down what arrived, send back
// what was answered. It never runs a workflow.
//
//   AGENTS_PG_HOST=db LUMEN_MASTER_KEY=… TRIGGER_BOT=<id> trigger-poller
//
// A process per bot, started as `joule-trigger@<bot-id>` — the same shape as
// joule-extract@1..4. That is not tidiness, it is the poll: `getUpdates` with
// a 25-second timeout BLOCKS, so ten bots sharing a loop means a message can
// wait four minutes for its turn. `Worker.run` cannot rescue that either, for
// the reason indexer.ts records — a worker body may not throw and everything
// here throws.
//
// This process runs forever, which is the opposite of scheduler.ts, and the
// difference is worth stating: the scheduler exits so it cannot leak, because
// this runtime never frees. A poller cannot exit — a fresh process per poll
// would drop the long poll's whole point. So it holds as little as it can and
// the unit carries MemoryMax and Restart=always instead. It is a socket, not
// a transcript.
//
// The loop, and the order matters:
//
//   claim the bot ──► send what the scheduler answered ──► poll ──►
//   ceiling check ──► inbox rows ──► move the cursor
//
// The cursor moves LAST. Telegram treats the next `offset` as the
// acknowledgement of everything below it, so committing before the rows exist
// turns a crash into a lost message. Committing after turns the same crash
// into a repeated one, and `takeMessage` refuses a repeat on update_id. A
// repeat can be rejected; a loss is invisible.

import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { connectDatabase } from "../plume/plume.ts";
import { credentialFor, masterKey } from "./credentials.ts";
import { TriggerBotRow, TriggerInboxRow, botById, claimBot, finishMessage, mayRun, nextOffset, noteBotPass, recentRuns, refuseMessage, saveBot, takeMessage, unsentFor, updatesIn, withRunCounted } from "./triggers.ts";
import { jsonText } from "./scan.ts";

// How long Telegram holds the request open with nothing to say. Long enough
// that an idle bot costs about two requests a minute; short enough that the
// lease below never expires under it.
const POLL_SECONDS: int = 25;
// After a failed poll. Telegram is down, the token was revoked, the network
// went — none of those are helped by asking again immediately.
const BACKOFF_MS: int = 5000;
// At most this many answers sent per pass, so a backlog cannot hold the poll
// closed for minutes.
const SEND_PER_PASS: int = 10;

function main(): void {
  let botId = process.env("TRIGGER_BOT") ?? "";
  if (botId == "") {
    console.error("trigger-poller: TRIGGER_BOT is not set — this process polls one bot and needs to know which");
    return;
  }
  let master = masterKey();
  if (master == "") {
    console.error("trigger-poller: LUMEN_MASTER_KEY is not set — the token cannot be read");
    return;
  }

  let db = postgres();
  let server: DbConfig = {
    host: process.env("AGENTS_PG_HOST") ?? "127.0.0.1",
    database: process.env("AGENTS_PG_DATABASE") ?? "agents",
    user: process.env("AGENTS_PG_USER") ?? "agents",
    password: process.env("AGENTS_PG_PASSWORD") ?? "",
  };
  connectDatabase(db, server);

  // No migrations here, for the reason indexer.ts and scheduler.ts both
  // record: the API owns the schema.
  let who = (process.env("HOSTNAME") ?? "poller") + ":" + botId;
  console.log("trigger-poller: " + botId + " starting");

  while (true) {
    try { pass(db, botId, who, master); }
    catch (e) {
      console.error("trigger-poller: " + e.message);
      process.sleep(BACKOFF_MS);
    }
  }
}

// One turn of the loop. Per pass rather than per statement, so a bot whose
// token was revoked backs off instead of spinning on the same failure.
function pass(db: Db, botId: string, who: string, master: string): void {
  let bot = botById(db, botId);
  if (bot.id == "") {
    console.error("trigger-poller: no bot " + botId);
    process.sleep(BACKOFF_MS);
    return;
  }
  if (!bot.enabled) {
    // Not an error: somebody switched it off. Keep the process alive so
    // switching it back on does not need systemd.
    process.sleep(BACKOFF_MS);
    return;
  }
  if (!claimBot(db, botId, who, Date.now() as number)) {
    // Somebody else is polling it. Two pollers on one bot would split a
    // conversation between them at random, so this one waits rather than
    // competing.
    process.sleep(BACKOFF_MS);
    return;
  }

  // (db, provider, masterKey) — the ref IS the provider name, minted as
  // "telegram:<bot id>" when the bot was created.
  let token = credentialFor(db, bot.credentialRef, master);
  if (token == "") {
    noteBotPass(db, bot.id, bot.offset, "no token stored for " + bot.credentialRef, Date.now() as number);
    process.sleep(BACKOFF_MS);
    return;
  }

  // Answers first: they are already paid for, and a person waiting on one
  // should not wait out a 25-second poll for it.
  sendAnswers(db, bot, token);

  let body = getUpdates(token, bot.offset);
  let said = updatesIn(body);
  if (said.length == 0) {
    // Not necessarily nothing — a body Telegram refused looks the same here,
    // so its own description is recorded rather than assumed absent.
    let problem = jsonText(body, "description");
    noteBotPass(db, bot.id, bot.offset, problem, Date.now() as number);
    return;
  }

  let counted = bot;
  let i: int = 0;
  while (i < said.length) {
    let now = Date.now() as number;
    let verdict = mayRun(counted, recentRuns(db, counted.id, now), now);
    if (verdict.ok) {
      if (takeMessage(db, counted, said[i], now) != "") {
        counted = withRunCounted(counted, now);
      }
    } else {
      // Refused, and told so. A message that vanishes reads as a broken bot;
      // "not now, and here is why" reads as a working one with a limit.
      if (refuseMessage(db, counted, said[i], verdict.reason, now) != "") {
        try { sendMessage(token, said[i].chatId, verdict.reason); }
        catch (e) { console.error("trigger-poller: could not say why: " + e.message); }
      }
    }
    i = i + 1;
  }
  saveBot(db, counted);
  // Last, and only now: every row above exists.
  noteBotPass(db, bot.id, nextOffset(said, bot.offset), "", Date.now() as number);
}

// What the scheduler answered, sent back. Per message try: one chat that has
// blocked the bot must not hold up the rest of the queue.
function sendAnswers(db: Db, bot: TriggerBotRow, token: string): void {
  let waiting = JSON.parse<TriggerInboxRow[]>(unsentFor(db, bot.id));
  let i: int = 0;
  while (i < waiting.length && i < SEND_PER_PASS) {
    let row = waiting[i];
    try {
      if (row.answer.trim() != "") { sendMessage(token, row.chatId, row.answer); }
      finishMessage(db, row, "sent", row.runId, row.answer, "", Date.now() as number);
    } catch (e) {
      console.error("trigger-poller: sending " + row.id + ": " + e.message);
      // Left 'done', so the next pass tries again. A send that failed because
      // Telegram was briefly down should not lose the answer.
    }
    i = i + 1;
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

// The token is in the URL because that is where Telegram's API puts it. It is
// therefore never logged from here — `console.error` in this file prints
// messages, never endpoints.
function api(token: string, method: string): string {
  return "https://api.telegram.org/bot" + token + "/" + method;
}

function getUpdates(token: string, offset: string): string {
  // allowed_updates narrows what Telegram sends to the one kind this acts on.
  // updatesIn steps over the rest anyway; asking for less is cheaper than
  // discarding more.
  let ask = "{\"offset\":" + (offset == "" ? "0" : offset)
    + ",\"timeout\":" + `${POLL_SECONDS}`
    + ",\"allowed_updates\":[\"message\"]}";
  let res = http.request(api(token, "getUpdates"), "POST", ask, jsonHeaders());
  // `ok` false is no answer at all — a dropped connection or a DNS failure.
  // An empty body reads as "nothing arrived", which is the right shape for
  // the caller: it records the pass and asks again.
  if (!res.ok) { return ""; }
  return res.body;
}

function sendMessage(token: string, chatId: string, text: string): void {
  let ask = "{\"chat_id\":" + chatId + ",\"text\":" + JSON.stringify(text) + "}";
  let res = http.request(api(token, "sendMessage"), "POST", ask, jsonHeaders());
  if (jsonText(res.body, "ok").trim() == "" && res.status >= 400) {
    throw new Error("telegram refused the message: " + `${res.status}`);
  }
}

function jsonHeaders(): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  return headers;
}

main();

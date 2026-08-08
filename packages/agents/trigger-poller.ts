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
import { TriggerBotRow, TriggerOutboxRow, botById, claimBot, markOutboundSent, mayRun, nextOffset, noteBotPass, parkFile, recentRuns, refuseMessage, replyKeyboard, saveBot, takeMessage, unsentOutbound, updatesIn, withRunCounted } from "./triggers.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { binaryKind, getArtifact, getVersion } from "./artifacts.ts";

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
// Base64 is 4/3 of the bytes and the artifact cap measures the STORED body;
// 20MB (all Telegram hands a bot) encodes to ~26.7MB, inside the deployed
// 28MB artifact ceiling — so Telegram's own limit is the only one a person
// ever meets. The raw-bytes gate here exists for the parked column.
const FILE_MAX_BYTES: number = 20000000.0;


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
      let rowId = takeMessage(db, counted, said[i], now);
      if (rowId != "") {
        counted = withRunCounted(counted, now);
        if (said[i].fileId != "") {
          // Download NOW, not from a queue: Telegram's file_path expires
          // within the hour, and the artifact ceiling is the size gate —
          // refused loudly rather than parked doomed.
          if (said[i].fileSize > FILE_MAX_BYTES) {
            try { sendMessage(token, said[i].chatId, "That file is " + `${said[i].fileSize}` + " bytes — I can read up to " + `${FILE_MAX_BYTES}` + ". Send a smaller one?", ""); }
            catch (e) { console.error("trigger-poller: size refusal: " + e.message); }
          } else {
            try {
              let got = fetchDocument(token, said[i].fileId);
              if (got != "") { parkFile(db, rowId, said[i].fileName, got); }
            } catch (e) {
              console.error("trigger-poller: download " + said[i].fileName + ": " + e.message);
            }
          }
        }
      }
    } else {
      // Refused, and told so. A message that vanishes reads as a broken bot;
      // "not now, and here is why" reads as a working one with a limit.
      if (refuseMessage(db, counted, said[i], verdict.reason, now) != "") {
        try { sendMessage(token, said[i].chatId, verdict.reason, ""); }
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
  // The outbox is the ONLY thing this sends. Every word that reaches a chat
  // was queued by a TELEGRAM_REPLY step — the graph says where it speaks,
  // END only records — so there is no second sending path reading the inbox,
  // and a message in the chat can always be pointed at the step that said
  // it. Oldest first: the order the run spoke is the order the chat reads.
  let speaking = JSON.parse<TriggerOutboxRow[]>(unsentOutbound(db, bot.id));
  let o: int = 0;
  while (o < speaking.length && o < SEND_PER_PASS) {
    let out = speaking[o];
    try {
      if ((out.filePath ?? "") != "") {
        sendDocument(db, token, out);
      } else if (out.text.trim() != "") {
        sendMessage(token, out.chatId, out.text, replyKeyboard(out.options ?? ""));
      }
      markOutboundSent(db, out.id, Date.now() as number);
    } catch (e) {
      console.error("trigger-poller: outbox " + out.id + ": " + e.message);
      // Left queued; the next pass tries again.
    }
    o = o + 1;
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

/** A document from the store to the phone: resolved at send time, decoded
 *  when the store holds base64 (the binaryKind boundary), and posted as the
 *  multipart upload Telegram's sendDocument wants. A Lumen string carries
 *  arbitrary bytes, which is the whole reason this can be built by hand. */
function sendDocument(db: Db, token: string, out: TriggerOutboxRow): void {
  let art = getArtifact(db, out.fileThread ?? "", out.filePath ?? "");
  if (art.id == "") {
    sendMessage(token, out.chatId, "The file " + (out.filePath ?? "") + " is not there any more.", "");
    return;
  }
  let held = getVersion(db, art.id, art.currentVersion);
  let bytes = binaryKind(art.kind) ? crypto.base64Decode(held.body) : held.body;
  let parts = (out.filePath ?? "/file").split("/");
  let name = parts.length == 0 ? "file" : parts[parts.length - 1];
  if (name == "") { name = "file"; }
  let B = "JouleBoundary7d29c1";
  let body = "--" + B + "\r\n"
    + "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + out.chatId + "\r\n"
    + (out.text.trim() == "" ? "" : "--" + B + "\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n" + out.text + "\r\n")
    + "--" + B + "\r\n"
    + "Content-Disposition: form-data; name=\"document\"; filename=\"" + name + "\"\r\n"
    + "Content-Type: application/octet-stream\r\n\r\n"
    + bytes + "\r\n--" + B + "--\r\n";
  let headers = new Map<string, string>();
  headers.set("content-type", "multipart/form-data; boundary=" + B);
  let res = http.request(api(token, "sendDocument"), "POST", body, headers);
  if (!res.ok || res.status >= 400) {
    throw new Error("telegram refused the document: " + `${res.status}` + " " + res.body.slice(0, 120));
  }
}

function sendMessage(token: string, chatId: string, text: string, markup: string): void {
  let ask = "{\"chat_id\":" + chatId + ",\"text\":" + JSON.stringify(text)
    + (markup == "" ? "" : ",\"reply_markup\":" + markup) + "}";
  let res = http.request(api(token, "sendMessage"), "POST", ask, jsonHeaders());
  if (jsonText(res.body, "ok").trim() == "" && res.status >= 400) {
    throw new Error("telegram refused the message: " + `${res.status}`);
  }
}

/** The document's bytes, base64 — or "" for anything that failed. Two calls
 *  on two HOSTS: getFile on the api host answers a short-lived path, and the
 *  bytes live on the file host. The token rides both URLs and is never
 *  logged, the rule this file already keeps. */
function fetchDocument(token: string, fileId: string): string {
  let asked = http.request(api(token, "getFile"), "POST",
    "{\"file_id\":" + JSON.stringify(fileId) + "}", jsonHeaders());
  if (!asked.ok) { return ""; }
  let path = jsonText(jsonRaw(asked.body, "result"), "file_path");
  if (path == "") { return ""; }
  let got = http.request("https://api.telegram.org/file/bot" + token + "/" + path,
    "GET", "", new Map<string, string>());
  if (!got.ok || got.status != 200) { return ""; }
  return crypto.base64Encode(got.body);
}

function jsonHeaders(): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  return headers;
}

main();

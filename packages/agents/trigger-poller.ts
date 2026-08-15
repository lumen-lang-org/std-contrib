import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { connectDatabase } from "../plume/plume.ts";
import { credentialFor, masterKey } from "./credentials.ts";
import { TriggerBotRow, TriggerOutboxRow, botById, claimBot, markOutboundSent, mayRun, nextOffset, noteBotPass, parkFile, recentRuns, refuseMessage, replyKeyboard, saveBot, takeMessage, unsentOutbound, updatesIn, withRunCounted } from "./triggers.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { binaryKind, getArtifact, getVersion } from "./artifacts.ts";

const POLL_SECONDS: int = 25;
const BACKOFF_MS: int = 5000;
const SEND_PER_PASS: int = 10;
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

  let who = (process.env("HOSTNAME") ?? "poller") + ":" + botId;
  console.log("trigger-poller: " + botId + " starting");

  while (true) {
    try {
      pass(db, botId, who, master);
    }
    catch (e) {
      console.error("trigger-poller: " + e.message);
      process.sleep(BACKOFF_MS);
    }
  }
}

function pass(db: Db, botId: string, who: string, master: string): void {
  let bot = botById(db, botId);
  if (bot.id == "") {
    console.error("trigger-poller: no bot " + botId);
    process.sleep(BACKOFF_MS);
    return;
  }
  if (!bot.enabled) {
    process.sleep(BACKOFF_MS);
    return;
  }
  if (!claimBot(db, botId, who, Date.now() as number)) {
    process.sleep(BACKOFF_MS);
    return;
  }

  let token = credentialFor(db, bot.credentialRef, master);
  if (token == "") {
    noteBotPass(db, bot.id, bot.offset, "no token stored for " + bot.credentialRef, Date.now() as number);
    process.sleep(BACKOFF_MS);
    return;
  }

  sendAnswers(db, bot, token);

  let body = getUpdates(token, bot.offset);
  let said = updatesIn(body);
  if (said.length == 0) {
    let fault = jsonText(body, "description");
    noteBotPass(db, bot.id, bot.offset, fault, Date.now() as number);
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
          if (said[i].fileSize > FILE_MAX_BYTES) {
            try {
              sendMessage(token, said[i].chatId, "That file is " + `${said[i].fileSize}` + " bytes — I can read up to " + `${FILE_MAX_BYTES}` + ". Send a smaller one?", "");
            }
            catch (e) {
              console.error("trigger-poller: size refusal: " + e.message);
            }
          } else {
            try {
              let got = fetchDocument(token, said[i].fileId);
              if (got != "") {
                parkFile(db, rowId, said[i].fileName, got);
              }
            } catch (e) {
              console.error("trigger-poller: download " + said[i].fileName + ": " + e.message);
            }
          }
        }
      }
    } else {
      if (refuseMessage(db, counted, said[i], verdict.reason, now) != "") {
        try {
          sendMessage(token, said[i].chatId, verdict.reason, "");
        }
        catch (e) {
          console.error("trigger-poller: could not say why: " + e.message);
        }
      }
    }
    i = i + 1;
  }
  saveBot(db, counted);
  noteBotPass(db, bot.id, nextOffset(said, bot.offset), "", Date.now() as number);
}

function sendAnswers(db: Db, bot: TriggerBotRow, token: string): void {
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
    }
    o = o + 1;
  }
}

function api(token: string, method: string): string {
  return "https://api.telegram.org/bot" + token + "/" + method;
}

function getUpdates(token: string, offset: string): string {
  let ask = "{\"offset\":" + (offset == "" ? "0" : offset)
    + ",\"timeout\":" + `${POLL_SECONDS}`
    + ",\"allowed_updates\":[\"message\"]}";
  let res = http.request(api(token, "getUpdates"), "POST", ask, jsonHeaders());
  if (!res.ok) {
    return "";
  }
  return res.body;
}

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
  if (name == "") {
    name = "file";
  }
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
  if (!res.ok) {
    throw new Error("telegram refused the message: " + `${res.status}`);
  }
}

function fetchDocument(token: string, fileId: string): string {
  let asked = http.request(api(token, "getFile"), "POST",
    "{\"file_id\":" + JSON.stringify(fileId) + "}", jsonHeaders());
  if (!asked.ok) {
    return "";
  }
  let path = jsonText(jsonRaw(asked.body, "result"), "file_path");
  if (path == "") {
    return "";
  }
  let got = http.request("https://api.telegram.org/file/bot" + token + "/" + path,
    "GET", "", new Map<string, string>());
  if (!got.ok || got.status != 200) {
    return "";
  }
  return crypto.base64Encode(got.body);
}

function jsonHeaders(): Map<string, string> {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  return headers;
}

main();

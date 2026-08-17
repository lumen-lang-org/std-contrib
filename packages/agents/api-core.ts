import { Db } from "../plume/driver.ts";
import { findById, jsonMember } from "../plume/plume.ts";
import { Reply, Request, BadRequest, header, Ok, Refused, queryParam, Respond } from "../rest/server.ts";
import { urlEncode } from "./mcp-oauth.ts";
import { caller } from "./caller.service.ts";
import { jsonText, jsonUnescape } from "./scan.ts";
import { enabledChoices, modelChoicesMapping } from "./schema.ts";
import { ToolCardRow } from "./toolcards.ts";

export function stamp(): string {
  return `${Date.now()}`;
}

// Resolvers. @From names a function, so these stay functions — each is a single
// call into the identity service, which is where the trust rule lives.
export function callerTags(req: Request): string[] {
  return caller().tags(req);
}

// Who the caller is, for a handler that wants the owner and not the machinery
// for working it out. Reading x-user is never enough — whether the proxy
// setting it is trusted is half the answer.
export function owningCaller(req: Request): string {
  return caller().owner(req);
}

export const GUEST_DAILY_RUNS: int = 10;

export function guestTag(tags: string[]): string {
  if (tags.length != 1) {
    return "";
  }
  if (!tags[0].startsWith("guest:")) {
    return "";
  }
  return tags[0];
}

export function guestQuotaJson(used: int, resetsAt: string): string {
  return "{\"error\":\"guest_quota\",\"limit\":" + `${GUEST_DAILY_RUNS}`
    + ",\"used\":" + `${used}`
    + ",\"remaining\":0"
    + ",\"resetsAt\":" + JSON.stringify(resetsAt) + "}";
}

export function bodyText(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw.length < 2 || !raw.startsWith("\"")) {
    return fallback;
  }
  return jsonUnescape(raw.slice(1, raw.length - 1));
}

export function bodyJson(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw == "") {
    return fallback;
  }
  if (raw.length >= 2 && raw.startsWith("\"")) {
    return jsonUnescape(raw.slice(1, raw.length - 1));
  }
  return raw;
}

export function bodyBool(body: string, key: string, fallback: bool): bool {
  let raw = jsonMember(body, key).trim();
  if (raw == "true" || raw == "\"true\"") {
    return true;
  }
  if (raw == "false" || raw == "\"false\"") {
    return false;
  }
  return fallback;
}

export function bodyInt(body: string, key: string, fallback: int): int {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") {
    return fallback;
  }
  return parseInt(raw, 10) ?? fallback;
}

export function bodyNumber(body: string, key: string, fallback: number): number {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") {
    return fallback;
  }
  let parsed = parseFloat(raw);
  if (parsed == null) {
    return fallback;
  }
  let value: number = parsed;
  return value;
}

export function bodyRank(body: string, fallback: int): int {
  if (jsonMember(body, "rank") != "") {
    return bodyInt(body, "rank", fallback);
  }
  return bodyInt(body, "menuRank", fallback);
}

export function askedChoice(body: string): string {
  if (body == "") {
    return "";
  }
  return jsonText(body, "modelChoiceId");
}

export function choiceFault(db: Db, choiceId: string): string {
  if (choiceId == "") {
    return "";
  }
  let offered = enabledChoices(db);
  let i: int = 0;
  while (i < offered.length) {
    if (offered[i].id == choiceId) {
      return "";
    }
    i = i + 1;
  }
  if (findById(db, modelChoicesMapping(), choiceId) == "") {
    return "no model choice " + choiceId;
  }
  return "model choice " + choiceId + " is not offered";
}

export function toolCardFault(row: ToolCardRow): string {
  if (row.id.trim() == "") {
    return "a tool card needs an id";
  }
  if (row.toolName.trim() == "") {
    return "a tool card needs the tool whose result it draws";
  }
  if (row.marker.trim() == "") {
    return "a tool card needs a marker";
  }
  if (row.marker.length > 32) {
    return "a marker is at most 32 characters";
  }
  let i: int = 0;
  while (i < row.marker.length) {
    let c = row.marker[i];
    let okChar = (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_";
    if (!okChar) {
      return "a marker is upper-case letters, digits and underscores — got \"" + row.marker + "\"";
    }
    i = i + 1;
  }
  return "";
}

export function boolJson(v: bool): string {
  if (v) {
    return "true";
  }
  return "false";
}

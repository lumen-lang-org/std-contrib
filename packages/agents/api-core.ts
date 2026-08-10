// The helpers every controller uses: who is calling, what time it is, and how
// to read one member out of a JSON body.

import { Request, header } from "../rest/server.ts";
import { jsonMember } from "../plume/plume.ts";
import { jsonUnescape } from "./scan.ts";
import { tagsFromHeader, trustsProxyAuth } from "./owner.ts";

export function stamp(): string {
  return `${Date.now()}`;
}

export function callerTags(req: Request): string[] {
  return tagsFromHeader(trustsProxyAuth(), header(req, "x-user"));
}

// How many turns a guest gets in one UTC day. The window is the calendar day
// — it resets at a moment the refusal can name honestly — and the count is
// runs, failed ones included, because a failed run spent a provider call too.
export const GUEST_DAILY_RUNS: int = 10;

// The caller's tag when the gateway minted this caller a guest identity, ""
// for everybody else. The gateway stamps guests `guest:<hex>`, and `:` cannot
// appear in a real user's uuid — so the prefix is the whole test. Only tags that came through `callerTags` reach here, which is what
// keeps the community deployment out of this entirely: untrusted, the tag
// list is empty and every caller is nobody's guest.
export function guestTag(tags: string[]): string {
  if (tags.length != 1) { return ""; }
  if (!tags[0].startsWith("guest:")) { return ""; }
  return tags[0];
}

// The 429 a guest over the day's ceiling gets. `remaining` is spelled out as 0
// — the client keys its wall off `error` but shows the numbers — and
// `resetsAt` is the same instant the Retry-After header counts down to.
export function guestQuotaJson(used: int, resetsAt: string): string {
  return "{\"error\":\"guest_quota\",\"limit\":" + `${GUEST_DAILY_RUNS}`
    + ",\"used\":" + `${used}`
    + ",\"remaining\":0"
    + ",\"resetsAt\":" + JSON.stringify(resetsAt) + "}";
}

// A top-level string member, or `fallback` when the body does not carry one.
export function bodyText(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw.length < 2 || !raw.startsWith("\"")) { return fallback; }
  return jsonUnescape(raw.slice(1, raw.length - 1));
}

// A top-level member's raw text, with a string member unquoted.
//
// For `extra`, which is a text column holding whatever a provider accepts that
// this schema does not name. A console that sends it as an object means the
// object; one that sends it as a string means the string. Both end up as the
// text the column holds.
export function bodyJson(body: string, key: string, fallback: string): string {
  let raw = jsonMember(body, key);
  if (raw == "") { return fallback; }
  if (raw.length >= 2 && raw.startsWith("\"")) {
    return jsonUnescape(raw.slice(1, raw.length - 1));
  }
  return raw;
}

// A top-level bool. `"true"` is taken as well as `true`, because an HTML form
// serialised by hand sends the first and refusing it teaches nobody anything.
export function bodyBool(body: string, key: string, fallback: bool): bool {
  let raw = jsonMember(body, key).trim();
  if (raw == "true" || raw == "\"true\"") { return true; }
  if (raw == "false" || raw == "\"false\"") { return false; }
  return fallback;
}

export function bodyInt(body: string, key: string, fallback: int): int {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") { return fallback; }
  return parseInt(raw, 10) ?? fallback;
}

export function bodyNumber(body: string, key: string, fallback: number): number {
  let raw = jsonMember(body, key).trim();
  if (raw.length >= 2 && raw.startsWith("\"")) {
    raw = raw.slice(1, raw.length - 1).trim();
  }
  if (raw == "") { return fallback; }
  let parsed = parseFloat(raw);
  if (parsed == null) { return fallback; }
  let value: number = parsed;
  return value;
}

// Where a row sits in the menu, under either of its two names.
//
// The record's field is `rank` and the column is `menu_rank` — RANK is a window
// function in MySQL 8 and `createTableSql` does not quote identifiers, which is
// why the column was renamed and the field was not (schema.ts says so at
// length). That leaves two spellings loose in the world, and both arrive here:
// `rank` is what every GET emits, `menuRank` is what the column is called.
// Taking `rank` first keeps the round trip lossless.
export function bodyRank(body: string, fallback: int): int {
  if (jsonMember(body, "rank") != "") { return bodyInt(body, "rank", fallback); }
  return bodyInt(body, "menuRank", fallback);
}

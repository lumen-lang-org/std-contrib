// The helpers every controller uses: who is calling, what time it is, and how
// to read one member out of a JSON body.

import { Db } from "../plume/driver.ts";
import { findById, jsonMember } from "../plume/plume.ts";
import { Reply, Request, badRequest, header, ok, problem, queryParam, reply } from "../rest/server.ts";
import { urlEncode } from "./mcp-oauth.ts";
import { tagsFromHeader, trustsProxyAuth } from "./owner.ts";
import { jsonText, jsonUnescape } from "./scan.ts";
import { enabledChoices, modelChoicesMapping } from "./schema.ts";
import { upstreamBase } from "./search-gateway.ts";
import { ToolCardRow } from "./toolcards.ts";

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

// The choice a body names, or "" for "no id".
//
// Read off the raw body rather than declared on a record, and BOTH halves of
// that rule are load-bearing. `JSON.parse<T>` refuses a document missing a
// member the record declares — so adding the field to a body record would
// refuse every request that leaves it out. It also refuses a document carrying
// a member the record does NOT declare, which is the half that was missed and
// the more expensive one: `{ text: string }` parsed against
// `{"text":"hi","modelChoiceId":""}` throws UnknownField, and that is the body
// the console sends on every single message. Declaring the field breaks the
// old callers; not declaring it breaks the new ones. So neither thread door
// parses its body into a narrow record at all — each reads the members it
// wants, exactly as `fromTemplate` reads `templateId`.
//
// Verified rather than reasoned about: both record types were run verbatim
// under `lumen run` against both body shapes.
export function askedChoice(body: string): string {
  if (body == "") { return ""; }
  return jsonText(body, "modelChoiceId");
}

// Why a chosen menu row will not be accepted, in words, or "".
//
// The door refuses what `chooseModel` tolerates, and the asymmetry is the point
// rather than an inconsistency to be tidied away. A thread that has pointed at
// a row since before the operator retired it must keep running — so the
// RESOLVER falls back to the agent's own model and writes a route note, because
// a conversation must not stop working because a menu changed. But a request
// arriving now with a `modelChoiceId` is a claim that the row exists now, made
// by a client that could have reloaded the menu; answering it on the agent's
// default while the composer reads "Thinking" tells the person nothing, and the
// only symptom is a picker that appears not to work. One is a memory, and it is
// absorbed; the other is an assertion, and it is answered.
//
// "Offered" is asked over the menu itself — the same read `GET /models/choices`
// answers with and the same one threads.ts resolves against — rather than by
// re-deciding it from a row's columns here. Two definitions of "offered" agree
// right up until somebody adds a condition to one of them.
export function choiceProblem(db: Db, choiceId: string): string {
  if (choiceId == "") { return ""; }
  let offered = enabledChoices(db);
  let i: int = 0;
  while (i < offered.length) {
    if (offered[i].id == choiceId) { return ""; }
    i = i + 1;
  }
  // The row is read only to tell the two mistakes apart, never to decide: an
  // id a client invented and a menu the operator changed under a console that
  // has not reloaded want different sentences, and "not offered" against an id
  // that was never a row would send somebody looking for a row to re-enable.
  if (findById(db, modelChoicesMapping(), choiceId) == "") {
    return "no model choice " + choiceId;
  }
  return "model choice " + choiceId + " is not offered";
}

// Secrets: values a workflow step may send but never hold (secrets.ts).
//
// Write-only by construction: POST takes the value and nothing answers one —
// the list is names, headers and destinations, and DELETE is the only other
// verb. There is deliberately no PUT: a secret's destination is authorised
// the moment its value is stored, and editing either half alone is the
// exfiltration this table exists to refuse. Change means delete and add
// again, with the value in hand.
// The one place a query leaves for the real search service. Both doors — the
// keyed /v1 and the signed-in playground — authenticate on their own and then
// come here, so the address, the allowed parameters and the "did it answer"
// check live once. Only the three named products build a path; a caller never
// names an upstream path of its own.
export function forwardProduct(req: Request, product: string): Reply {
  let q = queryParam(req, "q", "");
  if (q.trim() == "") { return badRequest("a query is required: ?q=..."); }
  let url = upstreamBase() + "/" + product + "?q=" + urlEncode(q);
  // suggest takes only q; the other two take a result count and hybrid toggle.
  if (product != "suggest") {
    let k = queryParam(req, "k", "");
    if (k != "") { url = url + "&k=" + urlEncode(k); }
    let hybrid = queryParam(req, "hybrid", "");
    if (hybrid != "") { url = url + "&hybrid=" + urlEncode(hybrid); }
  }
  if (product == "retrieve") {
    let mc = queryParam(req, "max_chars", "");
    if (mc != "") { url = url + "&max_chars=" + urlEncode(mc); }
  }
  // Filters the search API already understands, passed through when present.
  let site = queryParam(req, "site", "");
  if (site != "") { url = url + "&site=" + urlEncode(site); }
  let lang = queryParam(req, "lang", "");
  if (lang != "") { url = url + "&lang=" + urlEncode(lang); }
  let country = queryParam(req, "country", "");
  if (country != "") { url = url + "&country=" + urlEncode(country); }
  let res = http.request(url, "GET", "", new Map<string, string>());
  if (!res.ok) { return problem(502, "the search service did not answer"); }
  // The upstream's own JSON and its own status, verbatim — the gateway adds a
  // door, not a shape.
  return reply(res.status, res.body, "application/json");
}

// What a card row has to say to be usable.
//
// The marker is the strict one: it becomes [MARKER]…[/MARKER] in a reply, so a
// marker carrying a bracket or a space would produce a block nothing can
// parse — and the failure would look like a model that ignored instructions.
export function toolCardProblem(row: ToolCardRow): string {
  if (row.id.trim() == "") { return "a tool card needs an id"; }
  if (row.toolName.trim() == "") { return "a tool card needs the tool whose result it draws"; }
  if (row.marker.trim() == "") { return "a tool card needs a marker"; }
  if (row.marker.length > 32) { return "a marker is at most 32 characters"; }
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
  if (v) { return "true"; }
  return "false";
}

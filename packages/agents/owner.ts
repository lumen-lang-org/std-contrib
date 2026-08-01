// Whose row it is.
//
//   let tags = tagsFromHeader(trustsProxyAuth(), header(req, "x-user"));
//   let agentId = ownedThread(db, param(req, "id"), tags);   // "" is a 404
//
// The whole of the identity this package holds: one opaque string a trusted
// proxy named. No users table, no roles, no session, no token — those live in
// the gateway in front, which is the only thing that ever knew a password
// (GATEWAY.md, EDITIONS.md).
//
// Two rules carry the safety here, and both are about what happens when
// nothing is configured:
//
//   * The trust gate is OFF unless an operator turns it on. Unset, `X-USER` is
//     not read, no filter is applied and no owner is stamped — the community
//     edition, bit-for-bit what this served before owners existed. An
//     always-honoured header would make a half-configured proxy, or a box
//     someone forgot to firewall, an invitation to name any owner you like.
//   * A caller is a LIST of tags, and the empty list means "unscoped", not
//     "nobody". Only the door builds one; nothing downstream may synthesise a
//     list, because an accidental `[]` is scoping switched off wherever it is
//     written.
//
// One tag is what the gateway sends today. The list is what makes sharing a
// gateway change later rather than a signature change through sixteen call
// sites: the guard already asks "is the row's tag in the caller's set".
//
// Tested where the routes that use it are — what a route DECIDES is the whole
// subject of that suite, and the gate is a decision:
//
//   cd packages/agents && lumen test api.test.ts

import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";
import { jsonText } from "./scan.ts";

// Whether a proxy in front of this process is trusted to say who is calling.
//
// Anything but an explicit yes is no: a typo in the unit file must leave the
// engine identity-blind rather than half-scoped, and "0" or "false" must not
// read as truthy the way a bare presence check would.
export function trustsProxyAuth(): bool {
  let set = (process.env("AGENTS_TRUST_PROXY_AUTH") ?? "").trim().toLowerCase();
  return set == "1" || set == "true" || set == "yes" || set == "on";
}

// The tag for a caller whose identity document could not be read: a tenant of
// exactly nothing.
//
// No row holds it and none can come to. The leading space is what guarantees
// that rather than decorates it — every other tag is either "" or a trimmed
// header, so nothing a caller can send arrives with one — and the door refuses
// these requests, so no write ever stamps it either.
export const UNKNOWN_TAG: string = " unreadable x-user";

// The caller's tags, from the header the proxy set.
//
// Untrusted, the header is not read at all — not parsed, not logged, not
// compared. That is the community-safety property and it is one line: an
// engine reachable at :8100 by anything other than its proxy must not let the
// caller choose an identity.
//
// Trusted, the tag is the `uuid` of nuraly's X-USER document — the stable id,
// never the username or the email, both of which a user can change and
// neither of which owns anything. A header that is not that document is taken
// whole and trimmed, which is the self-hoster's case: an nginx with basic-auth
// in front setting `X-USER: alice` gets multi-user scoping for free, which is
// the documented community contract.
//
// A trusted request with no header is one tag, "": it sees the unowned rows
// and writes unowned rows. Never a mix of "" and a real tag — the cutover rule
// that keeps pre-gateway history from leaking to every authenticated user.
//
// A document whose `uuid` cannot be read is NOT that case, and the difference
// is the whole of the danger here. `jsonText` answers "" for a member that is
// absent, null, or not a string, so an anonymous-user document, a renamed
// field or a shape nobody anticipated would otherwise hand the caller the ""
// tag — read and write access to every pre-gateway thread, artifact, file and
// run, indistinguishable in the logs from an ordinary headerless request. It
// gets `UNKNOWN_TAG` instead, and `identityUnreadable` below lets the door
// answer 401 before a route sees it at all.
export function tagsFromHeader(trusted: bool, xUser: string): string[] {
  let none: string[] = [];
  if (!trusted) { return none; }
  let text = xUser.trim();
  if (text.startsWith("{")) {
    let uuid = jsonText(text, "uuid");
    if (uuid == "") { return [UNKNOWN_TAG]; }
    return [uuid];
  }
  return [text];
}

// Whether the caller sent an identity document this process cannot read a
// `uuid` out of. Asked at the door, where a 401 is honest: the proxy claims to
// have authenticated somebody it cannot name, and guessing which tenant that
// is means guessing wrong in the direction of somebody else's data.
export function identityUnreadable(trusted: bool, xUser: string): bool {
  let tags = tagsFromHeader(trusted, xUser);
  return tags.length == 1 && tags[0] == UNKNOWN_TAG;
}

// `owner IN (…)` against `tags`, with placeholders numbered from `from`, or ""
// when the caller is unscoped. Composed into a WHERE, so it never carries the
// keyword itself.
//
// The filter belongs in SQL and not in a loop over the answer: a post-filter
// pages over every tenant's rows and throws most of the page away, so page two
// repeats rows, page ten is empty while the caller still has conversations,
// and the database scans everybody to serve one.
export function ownerClause(db: Db, tags: string[], from: int): string {
  if (tags.length == 0) { return ""; }
  let out = "owner IN (";
  let i: int = 0;
  while (i < tags.length) {
    if (i > 0) { out = out + ", "; }
    out = out + placeholderAt(db, from + i);
    i = i + 1;
  }
  return out + ")";
}

// The tag a row this caller creates is stamped with. Ownership is ONE tag —
// the caller's own — even once the set it may read grows past it; and "" when
// there is no proxy to say otherwise, which is what every existing row holds.
export function owningTag(tags: string[]): string {
  if (tags.length == 0) { return ""; }
  return tags[0];
}

// Whether a row this caller may reach. An unscoped caller reaches everything,
// which is what the community edition has always done.
export function holdsOwner(tags: string[], owner: string): bool {
  if (tags.length == 0) { return true; }
  let i: int = 0;
  while (i < tags.length) {
    if (tags[i] == owner) { return true; }
    i = i + 1;
  }
  return false;
}

// The same question asked of a row document as the database answered it.
export function documentIsOwned(document: string, tags: string[]): bool {
  return holdsOwner(tags, jsonText(document, "owner"));
}

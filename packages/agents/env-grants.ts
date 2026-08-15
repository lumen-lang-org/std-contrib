import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, persist, findById, listOrdered, deleteWhere, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { EnvRow, envBySlug, envMapping, envReachAddr, envStampLess } from "./environments.ts";

// A grant is how a browser is let into an environment's own origin.
//
// The console cannot sit in front of every request an environment serves — the
// browser talks to it directly — so the entry has to be something the gateway
// can check on its own. It is deliberately not a signed token: the engine has
// no HMAC, the gateway already has a careful one, and a row buys three things a
// signature does not. It can be revoked, single use is an update rather than a
// nonce to remember, and the thing being granted is looked up in the same
// breath as the grant is checked.
//
// Sixty seconds and one use. It crosses one redirect and is then spent: what
// holds the session afterwards is a cookie the gateway mints for that host
// alone, and no credential of the reader's ever reaches the container.

export const ENV_GRANT_TTL_MS: int = 60000;

export type EnvGrantRow = {
  id: string,
  /** The environment's own name, not the conversation's: a grant is redeemed
   *  at the hostname it names, and nowhere else. */
  slug: string,
  owner: string,
  expiresAt: string,
  /** Empty until it is spent, and a stamp forever after. */
  usedAt: string,
  createdAt: string,
};

export function envGrantsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("slug", "slug", "text"),
    field("owner", "owner", "text"),
    field("expiresAt", "expires_at", "text"),
    field("usedAt", "used_at", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "env_grants", idField: "id", idColumn: "id", fields: fs });
}

export function envGrantsPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("120", "grants into an environment", createTableSql(db, envGrantsMapping())),
    migration("121", "grants are swept by when they lapse",
      "CREATE INDEX IF NOT EXISTS env_grants_by_expiry ON env_grants (expires_at)"),
  ];
  return plan;
}

/** The zone published environments answer under, without a leading dot, and
 *  empty when this deployment publishes none. Empty is the default: a
 *  deployment cannot start handing out hostnames by omission. */
let envZoneChosen: string = "";

export function envZoneOverride(zone: string): void {
  envZoneChosen = zone;
}

export function envZone(): string {
  if (envZoneChosen != "") {
    return envZoneChosen;
  }
  return (process.env("AGENTS_ENV_ZONE") ?? "").trim().toLowerCase();
}

/** One label per environment, at the zone's first level. Cloudflare's universal
 *  certificate covers one wildcard level and no more, so a second label here
 *  would be a name TLS does not cover. */
export function envHostFor(slug: string): string {
  let zone = envZone();
  if (zone == "" || slug == "") {
    return "";
  }
  return "env-" + slug + "." + zone;
}

export type EnvGrantMint = {
  threadId: string,
  name: string,
  owner: string,
  now: string,
};

export type EnvGranted = {
  ok: bool,
  token: string,
  slug: string,
  url: string,
  fault: string,
};

function envGrantRefused(why: string): EnvGranted {
  let r: EnvGranted = { ok: false, token: "", slug: "", url: "", fault: why };
  return r;
}

// Thirty-two hex characters, from the same source the preview tokens come from.
function envGrantToken(): string {
  let raw = crypto.randomUUID();
  let out = "";
  let i: int = 0;
  while (i < raw.length) {
    let c = raw.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102)) {
      out = out + raw.charAt(i);
    }
    i = i + 1;
  }
  return out;
}

// The one ownership check on this path. Everything after it trusts the grant,
// so it is asked of the conversation the environment belongs to, not of the
// caller's word.
function envThreadOwnedBy(db: Db, threadId: string, owner: string): bool {
  if (threadId == "" || owner == "") {
    return false;
  }
  if (!db.query("SELECT 1 FROM threads WHERE id = " + placeholderAt(db, 1)
    + " AND owner = " + placeholderAt(db, 2), [threadId, owner])) {
    return false;
  }
  return db.rows() > 0;
}

/** Whose conversation this is. Lives here rather than being imported from
 *  threads.ts, which reaches run.ts and closes an import cycle back through the
 *  tools that call this. */
export function envThreadOwner(db: Db, threadId: string): string {
  if (threadId == "") {
    return "";
  }
  if (!db.query("SELECT owner FROM threads WHERE id = " + placeholderAt(db, 1), [threadId])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  return db.value(0, 0);
}

export function envGrantMint(db: Db, m: EnvGrantMint): EnvGranted {
  if (envZone() == "") {
    return envGrantRefused("this deployment serves no environments on the web — set AGENTS_ENV_ZONE to the zone their hostnames sit in");
  }
  let name = m.name == "" ? "main" : m.name;
  let held = findById(db, envMapping(), m.threadId + ":" + name);
  if (held == "") {
    return envGrantRefused("there is no environment called '" + name + "' in this conversation");
  }
  let row = JSON.parse<EnvRow>(held);
  if (!envThreadOwnedBy(db, row.threadId, m.owner)) {
    return envGrantRefused("this environment belongs to another conversation than yours");
  }
  if (row.slug == "") {
    return envGrantRefused("this environment has no name of its own yet — run something in it and it will be given one");
  }
  if (row.servePort == 0) {
    return envGrantRefused("this environment serves nothing: it was built without a published port");
  }
  let token = envGrantToken();
  let grant: EnvGrantRow = {
    id: token,
    slug: row.slug,
    owner: m.owner,
    expiresAt: envStampPlus(m.now, ENV_GRANT_TTL_MS),
    usedAt: "",
    createdAt: m.now,
  };
  let written = persist(db, envGrantsMapping(), JSON.stringify(grant));
  if (!written.ok) {
    return envGrantRefused("the grant could not be stored, so the link would not "
      + "open anything: " + written.error);
  }
  let made: EnvGranted = {
    ok: true,
    token: token,
    slug: row.slug,
    url: "https://" + envHostFor(row.slug) + "/__grant?t=" + token,
    fault: "",
  };
  return made;
}

/** A reader is looking at it, so it is not idle.
 *
 *  The idle sweep stops an environment fifteen minutes after its last ensure,
 *  which without this stops a dev server somebody is watching — and takes its
 *  workspace sync with it. The gateway asks this on a cache miss, which is
 *  roughly twice a minute per reader, so the write is cheap and the sweep sees
 *  the truth. */
export function envTouch(db: Db, slug: string, now: string): bool {
  let row = envBySlug(db, slug);
  if (row.slug == "" || now == "") {
    return false;
  }
  let seen: EnvRow = {
    id: row.id, threadId: row.threadId, name: row.name, image: row.image,
    network: row.network, status: row.status, slug: row.slug,
    hostPort: row.hostPort, servePort: row.servePort, serveCmd: row.serveCmd,
    syncAt: row.syncAt, createdAt: row.createdAt, lastUsedAt: now,
  };
  let noted = persist(db, envMapping(), JSON.stringify(seen));
  if (!noted.ok) {
    console.error("envTouch: " + slug + " was not marked as watched, so the idle "
      + "sweep may stop it under its reader: " + noted.error);
    return false;
  }
  return true;
}

export type EnvReached = {
  ok: bool,
  threadId: string,
  name: string,
  upstream: string,
  fault: string,
};

function envReachRefused(threadId: string, name: string, why: string): EnvReached {
  let r: EnvReached = {
    ok: false, threadId: threadId, name: name, upstream: "", fault: why,
  };
  return r;
}

/** Where a hostname's traffic goes, asked afresh rather than remembered: docker
 *  moves the port on every restart, and a stale answer would send a reader's
 *  request to whatever holds that port now. */
export function envReach(db: Db, slug: string): EnvReached {
  let row = envBySlug(db, slug);
  if (row.slug == "") {
    return envReachRefused("", "", "no environment answers to that name");
  }
  if (row.status != "running" || row.hostPort == 0) {
    return envReachRefused(row.threadId, row.name, "this environment is not running");
  }
  let bind = envReachAddr();
  if (bind == "") {
    return envReachRefused(row.threadId, row.name, "this deployment publishes no environment ports");
  }
  let there: EnvReached = {
    ok: true,
    threadId: row.threadId,
    name: row.name,
    upstream: bind + ":" + `${row.hostPort}`,
    fault: "",
  };
  return there;
}

export type EnvRedeem = {
  token: string,
  /** Read from the Host header, so a grant for one environment cannot be spent
   *  on another's hostname to get a cookie for it. */
  slug: string,
  now: string,
};

export type EnvRedeemed = {
  ok: bool,
  slug: string,
  threadId: string,
  name: string,
  owner: string,
  upstream: string,
  fault: string,
};

function envRedeemRefused(why: string): EnvRedeemed {
  let r: EnvRedeemed = {
    ok: false, slug: "", threadId: "", name: "", owner: "", upstream: "", fault: why,
  };
  return r;
}

export function envGrantRedeem(db: Db, r: EnvRedeem): EnvRedeemed {
  if (r.token == "" || r.slug == "") {
    return envRedeemRefused("this is not a grant");
  }
  let held = findById(db, envGrantsMapping(), r.token);
  if (held == "") {
    return envRedeemRefused("this grant is not one of ours");
  }
  let grant = JSON.parse<EnvGrantRow>(held);
  if (grant.usedAt != "") {
    return envRedeemRefused("this grant has already been used");
  }
  if (!envStampLess(r.now, grant.expiresAt)) {
    return envRedeemRefused("this grant has expired");
  }
  if (grant.slug != r.slug) {
    return envRedeemRefused("this grant is for another environment");
  }
  let reached = envReach(db, r.slug);
  if (!reached.ok) {
    return envRedeemRefused(reached.fault);
  }
  // Spent before the answer is given, so a redirect that is replayed, or two
  // tabs racing the same link, redeem once between them.
  let spent: EnvGrantRow = {
    id: grant.id, slug: grant.slug, owner: grant.owner,
    expiresAt: grant.expiresAt, usedAt: r.now, createdAt: grant.createdAt,
  };
  let marked = persist(db, envGrantsMapping(), JSON.stringify(spent));
  if (!marked.ok) {
    // Refused rather than let through: a grant that is not written as spent is
    // a grant that redeems again, and this is the whole of the credential.
    return envRedeemRefused("this grant could not be marked as used, so it is not "
      + "being honoured; ask for another");
  }
  let done: EnvRedeemed = {
    ok: true,
    slug: grant.slug,
    threadId: reached.threadId,
    name: reached.name,
    owner: grant.owner,
    upstream: reached.upstream,
    fault: "",
  };
  return done;
}

/** Spent and lapsed grants, cleared on the same sweep that stops idle
 *  containers. A grant lives a minute; the row should not outlive the day. */
export function envGrantSweep(db: Db, now: string): int {
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envGrantsMapping(), {
    where: "expires_at < " + placeholderAt(db, 1),
    args: [now],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return 0;
  }
  let rows = JSON.parse<EnvGrantRow[]>(listed);
  let gone: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    if (envStampLess(rows[i].expiresAt, now)) {
      let cleared = deleteWhere(db, envGrantsMapping(), "id = " + placeholderAt(db, 1), [rows[i].id]);
      if (cleared.ok) {
        gone = gone + 1;
      } else {
        console.error("envGrantSweep: " + rows[i].id + " stayed: " + cleared.error);
      }
    }
    i = i + 1;
  }
  return gone;
}

// Stamps are decimal strings, and the one piece of arithmetic this file needs
// is addition. Written out rather than parsed to a number: the milliseconds
// since 1970 are already wider than a float carries exactly.
function envStampPlus(now: string, ms: int): string {
  let adding = `${ms}`;
  let out = "";
  let ai: int = now.length - 1;
  let bi: int = adding.length - 1;
  let carry: int = 0;
  while (ai >= 0 || bi >= 0 || carry > 0) {
    let da = ai >= 0 ? now.charCodeAt(ai) - 48 : 0;
    let db2 = bi >= 0 ? adding.charCodeAt(bi) - 48 : 0;
    if (da < 0 || da > 9 || db2 < 0 || db2 > 9) {
      return now;
    }
    let sum = da + db2 + carry;
    carry = sum >= 10 ? 1 : 0;
    out = "0123456789".charAt(sum - carry * 10) + out;
    ai = ai - 1;
    bi = bi - 1;
  }
  return out == "" ? now : out;
}

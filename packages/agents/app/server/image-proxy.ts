// Story pictures, fetched by this server rather than by the reader.
//
// The index now answers with an `image` for a crawled page, and the digest
// keeps whichever of a story's sources carries one. Putting that url straight
// into an `<img src>` would work and is the wrong thing:
//
//   * It is the READER's browser talking to a site they did not choose to
//     visit. Their IP address, their user agent, and — without care — the page
//     they were on all reach a third party because they scrolled past a card.
//   * It leaks in the other direction too. A publisher watching their image
//     logs sees this deployment's readers arriving one by one.
//   * It is a broken picture the first time a site sets hotlink protection,
//     goes down, or moves the file, and the console has no way to notice.
//
// So the bytes come through here. One hop, cached, and the reader's browser
// only ever talks to this origin.
//
// ADDRESSED BY STORY, NEVER BY URL, and that is the security property rather
// than a convenience. A proxy that takes `?url=` is a hole punched from the
// public internet into whatever this container can reach: the engine on 8100,
// the index on the tailnet, a cloud metadata endpoint. There is no allowlist
// clever enough to make that shape safe, and there is no need for one — the
// console knows which story it is drawing, so the caller names a story and
// the URL is read out of the row the engine stored. The set of addresses this
// file will ever fetch is exactly the set the crawler put in the index.
//
// What still gets checked, because "the engine said so" is not a promise
// about a string a crawler read off somebody else's page:
//
//   * `https:` only. Not `http:` (a mixed-content downgrade), not `data:`
//     (bytes a crawled page controls, decoded by this origin), not `file:`.
//   * A public address. A crawled page can link its image to `127.0.0.1` or
//     `169.254.169.254` as easily as to a CDN, and DNS can point a public
//     name at either. The response's own address is checked after the
//     connection is made, so a name that resolves inward is refused even
//     though it looked fine.
//   * A size and a time budget, and an `image/*` content type. What comes
//     back is a file from a stranger; it is served with `nosniff` and a CSP
//     of its own so that even a mislabelled one is inert.

import type { IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { engineUrl } from "./engine.js";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

const PREFIX = "/img/story/";

/* The budgets.
 *
 * Two seconds because nobody is waiting on a picture the way they wait on a
 * page: the card draws without it and fills in, so a slow publisher costs a
 * late image rather than a late feed. Two megabytes because an `og:image` is
 * a social-card asset — the ones that are bigger than this are bigger by
 * mistake, and streaming a 40MB PNG to every reader of a feed is a bandwidth
 * bill for a thumbnail. */
const WAIT_MS = 2_000;
const MAX_BYTES = 2 * 1024 * 1024;

/* The cache.
 *
 * In memory, and that is the right size for what this is. A feed holds a few
 * dozen stories, each has at most one picture, and the whole working set is
 * a handful of megabytes — a disk cache would be a file-locking problem in
 * exchange for surviving a restart that happens on deploys and nothing else.
 *
 * Keyed by STORY, not by url, so a refresh that gives a story a different
 * picture serves the new one within the hour rather than forever. The hour
 * is also the ceiling on how wrong this can be: the digest runs every thirty
 * minutes, so at worst a card shows the previous pass's picture for one more
 * pass.
 *
 * A NEGATIVE entry is cached too, and it is the one that matters most for
 * cost. Roughly nineteen crawled pages in twenty have no image at all, and a
 * publisher who blocks hotlinking blocks it every time — without this, every
 * paint of every card would re-ask the engine and re-fetch a 403. */
type Shot = { at: number; type: string; body: Buffer | null };
const shots = new Map<string, Shot>();
const TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
/* A ceiling on entries as well as on age, because a long-lived process
   serving many feeds would otherwise grow without bound. Oldest out first —
   the map preserves insertion order, so the first key is the oldest. */
const MAX_ENTRIES = 400;

function remember(id: string, shot: Shot): void {
  if (shots.size >= MAX_ENTRIES) {
    const oldest = shots.keys().next();
    if (!oldest.done) shots.delete(oldest.value);
  }
  shots.set(id, shot);
}

function fresh(shot: Shot | undefined): boolean {
  if (shot === undefined) return false;
  const life = shot.body === null ? MISS_TTL_MS : TTL_MS;
  return Date.now() - shot.at < life;
}

/** A private, loopback, link-local or otherwise non-routable address.
 *
 *  Checked against the address actually connected to rather than against the
 *  hostname, because a name is not an address: `images.example.com` may have
 *  an A record pointing at 10.0.0.5, and only resolving it says so. */
function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    // Loopback, unspecified, link-local, unique-local, and IPv4 wearing an
    // IPv6 hat — which is how the same private ranges arrive on a dual-stack
    // host.
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea")
      || low.startsWith("feb")) return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivate(low.slice("::ffff:".length));
    return false;
  }
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT, link-local (which is where cloud metadata lives), and
  // everything above the unicast range.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

/** Whether this url is one this server may open. */
async function reachable(url: URL): Promise<boolean> {
  if (url.protocol !== "https:") return false;
  try {
    // Every address the name has, not just the first: a name that resolves to
    // one public and one private address must be refused, because which one
    // the socket picks is not this code's decision.
    const all = await lookup(url.hostname, { all: true });
    if (all.length === 0) return false;
    return !all.some((a) => isPrivate(a.address));
  } catch {
    return false;
  }
}

/** The url the engine has for this story, or "" — asked as the caller, so a
 *  story the caller may not read answers nothing here either. */
async function imageUrlFor(id: string, req: IncomingMessage): Promise<string> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const who = req.headers["x-user"];
    if (typeof who === "string" && who !== "") headers["x-user"] = who;
    const answer = await fetch(engineUrl(`/discover/story/${encodeURIComponent(id)}`), {
      signal: AbortSignal.timeout(WAIT_MS),
      headers,
    });
    if (!answer.ok) return "";
    const held = await answer.json() as { story?: { image?: unknown } };
    const url = held?.story?.image;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

/** Fetch it, within the budgets. Null for anything that is not an image this
 *  server is willing to pass on. */
async function pull(url: URL): Promise<Shot | null> {
  try {
    const answer = await fetch(url, {
      signal: AbortSignal.timeout(WAIT_MS),
      // No credentials, ever, and a `referrer` that names nothing: the
      // publisher learns that something fetched their picture and not who
      // was reading. `manual` on redirects because a 302 is a second address
      // this file has not checked — following it would walk straight around
      // `reachable`.
      redirect: "manual",
      referrerPolicy: "no-referrer",
      headers: { accept: "image/*" },
    });
    if (!answer.ok) return null;
    const type = (answer.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const declared = Number.parseInt(answer.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
    const body = Buffer.from(await answer.arrayBuffer());
    // Checked again after reading: `content-length` is a claim, and a server
    // that omits it or lies about it is exactly the one worth capping.
    if (body.byteLength > MAX_BYTES) return null;
    return { at: Date.now(), type, body };
  } catch {
    return null;
  }
}

/** Nothing to show. 204 rather than 404 — most stories have no picture, and a
 *  console log full of 404s for the ordinary case teaches everybody to ignore
 *  the log. The element hides itself either way. */
function nothing(res: ServerResponse, seconds: number): void {
  res.statusCode = 204;
  res.setHeader("cache-control", `public, max-age=${seconds}`);
  res.end();
}

export function imageProxy(): Middleware {
  return (req, res, next) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!path.startsWith(PREFIX)) return next();
    if ((req.method ?? "GET").toUpperCase() !== "GET") return next();

    const id = decodeURIComponent(path.slice(PREFIX.length));
    if (id === "" || id.includes("/")) return nothing(res, 60);

    void (async () => {
      const held = shots.get(id);
      if (fresh(held)) {
        if (held!.body === null) return nothing(res, 60);
        return serve(res, held!);
      }

      const said = await imageUrlFor(id, req);
      if (said === "") {
        remember(id, { at: Date.now(), type: "", body: null });
        return nothing(res, 300);
      }

      let url: URL;
      try {
        url = new URL(said);
      } catch {
        remember(id, { at: Date.now(), type: "", body: null });
        return nothing(res, 300);
      }
      if (!await reachable(url)) {
        remember(id, { at: Date.now(), type: "", body: null });
        return nothing(res, 300);
      }

      const shot = await pull(url);
      if (shot === null) {
        remember(id, { at: Date.now(), type: "", body: null });
        return nothing(res, 300);
      }
      remember(id, shot);
      serve(res, shot);
    })();
  };
}

/** The bytes, hedged.
 *
 *  `nosniff` and a CSP of `default-src 'none'` because this is a file from a
 *  stranger served off this origin: even a response that lied about being an
 *  image cannot then be treated as a script or a document. `Content-
 *  Disposition: inline` with no filename keeps a browser from ever offering
 *  the publisher's own name for it. */
function serve(res: ServerResponse, shot: Shot): void {
  res.statusCode = 200;
  res.setHeader("content-type", shot.type);
  res.setHeader("content-length", String(shot.body!.byteLength));
  res.setHeader("cache-control", "public, max-age=3600");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  res.setHeader("content-disposition", "inline");
  res.end(shot.body);
}

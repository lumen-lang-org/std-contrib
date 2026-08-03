// GET /reader?u=<url> — a page, reduced to what an overlay can show.
//
// The link preview cannot be an <iframe>: the console's CSP names exactly one
// frameable origin on purpose (server/csp.ts rule 3 — a wildcard would let
// any site the model can name be framed by the console), and half the web
// sends X-Frame-Options anyway. So the preview is a reading: this endpoint
// fetches the page server-side, keeps the title and the text, and answers
// JSON the overlay lays out itself. No script survives, nothing is framed,
// and a site that refuses robots entirely still answers something — the
// error, and the overlay's "open in browser" button is right there.
//
// The abuse surface is real and bounded: this is an anonymous fetch relay if
// the gateway lets guests reach it, so it refuses everything but http(s),
// refuses hosts that resolve into private space (the engine, the gateway,
// the tailnet — an SSRF answering "what does 172.17.0.1:8100/providers say"
// would be a credential audit), caps the body at a megabyte and the wait at
// eight seconds, and answers text only — never the page's own markup.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type Middleware = (req: { url?: string }, res: {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
}, next: () => void) => void;

const BODY_MAX = 1_000_000;
const WAIT_MS = 8_000;

function privateIp(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")
    || ip.startsWith("169.254.") || ip.startsWith("100.")
    || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

/* The readable part of an HTML document, with no HTML left in it.
   Not a readability engine: scripts, styles and tags go, entities come back,
   and whatever text remains is split on the block boundaries the source
   already had. A wrong guess here shows a worse preview, never a script. */
function extract(html: string): { title: string; paragraphs: string[] } {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<(p|div|h1|h2|h3|h4|li|br|section|article)\b[^>]*>/gi, "\n<>")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const paragraphs = body.split("\n<>")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 60)
    .slice(0, 40);
  return { title, paragraphs };
}

export function reader(): Middleware {
  return (req, res, next) => {
    const raw = req.url ?? "";
    if (!raw.startsWith("/reader?") && raw !== "/reader") { next(); return; }
    const answer = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=600");
      res.end(JSON.stringify(body));
    };
    void (async () => {
      try {
        const u = new URL(raw, "http://x").searchParams.get("u") ?? "";
        let target: URL;
        try { target = new URL(u); } catch { answer(400, { error: "not a url" }); return; }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          answer(400, { error: "http(s) only" }); return;
        }
        const host = target.hostname;
        const ip = isIP(host) ? host : (await lookup(host).catch(() => null))?.address ?? "";
        if (ip === "" || privateIp(ip)) { answer(400, { error: "that host is not reachable from here" }); return; }

        const got = await fetch(target.href, {
          redirect: "follow",
          signal: AbortSignal.timeout(WAIT_MS),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; JouleReader/1.0; +https://joule.sh)" },
        });
        const kind = got.headers.get("content-type") ?? "";
        if (!kind.includes("html") && !kind.includes("text/plain")) {
          answer(200, { title: "", host: target.hostname, paragraphs: [],
            note: "This link is a " + (kind.split(";")[0] || "file") + ", not a page." });
          return;
        }
        const text = (await got.text()).slice(0, BODY_MAX);
        const out = extract(text);
        answer(200, { title: out.title, host: target.hostname, paragraphs: out.paragraphs });
      } catch (e) {
        answer(200, { title: "", host: "", paragraphs: [],
          note: "The page could not be read from here." });
      }
    })();
  };
}

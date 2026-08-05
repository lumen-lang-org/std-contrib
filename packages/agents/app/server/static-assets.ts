// The four brand files, served from disk.
//
// LumenJS serves pages and built modules; it has no public/ convention, and
// these are the only static files the console has ever needed — a favicon
// set and the share-card image. A middleware of four paths is smaller than
// adopting a static-file layer for it, and it slots into the same chain the
// proxy already rides.
//
// Read per request, not cached: four small files behind long-lived browser
// caching (immutable would be a lie — og.png is regenerated when the home
// changes — so a day is the compromise).

import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

type Middleware = (req: { url?: string }, res: {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(body?: string): void;
}, next: () => void) => void;

const SERVED: Record<string, { file: string; mime: string }> = {
  // The SVG mark is what a current browser takes — it is the one that follows
  // the tab strip's theme, so the J is ink on a light strip and white on a
  // dark one rather than a black square either way.
  //
  // NOT at /favicon.svg, which is the name the framework's own <link> uses
  // (dist/dev-server/index-html.js emits it and this app has no file behind
  // it). That path answers with the SPA's HTML, and a browser handed HTML
  // where an image was promised shows no icon at all — which is what joule.sh
  // did until this line existed. Ours is declared later in head.html and a
  // later rel=icon wins, so the framework's tag is left alone.
  "/mark.svg": { file: "mark.svg", mime: "image/svg+xml" },
  "/favicon.ico": { file: "favicon-32.png", mime: "image/png" },
  "/favicon-32.png": { file: "favicon-32.png", mime: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", mime: "image/png" },
  "/icon-512.png": { file: "icon-512.png", mime: "image/png" },
  "/og.png": { file: "og.png", mime: "image/png" },
};

export function staticAssets(): Middleware {
  const dir = join(process.cwd(), "assets");
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    const hit = SERVED[path];
    if (hit === undefined) { next(); return; }
    const full = join(dir, hit.file);
    if (!existsSync(full)) { next(); return; }
    res.statusCode = 200;
    res.setHeader("Content-Type", hit.mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    createReadStream(full).pipe(res as unknown as NodeJS.WritableStream);
  };
}

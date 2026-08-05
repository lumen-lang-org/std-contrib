// Recording what a conversation actually does to the browser.
//
// The chat specs next door assert one fact each and stop. That is the right
// shape for a regression test and the wrong shape for finding what nobody has
// noticed yet: a console error thrown on turn three, a stream that arrives in
// four slabs rather than a hundred, an icon that drew its own name. None of
// those fail an assertion anybody thought to write, and all of them are on
// screen the whole time.
//
// So this module watches instead of asserting. It attaches to everything the
// page emits — console, uncaught errors, failed requests, HTTP status — and
// samples the transcript from INSIDE the page at 25ms, which is the part a
// round-tripping test cannot do: `locator.textContent()` costs a few
// milliseconds per call, so a test that polls it is measuring its own latency
// as much as the model's. An in-page interval writing into an array, read once
// at the end, measures the render.
//
// The output is a JSON file, not a pass/fail. `score()` below turns it into
// findings, and the scenario asserts on those — so a threshold can be argued
// with in one place rather than being spread over twenty expects, and a run
// that finds something new still writes it down even when every threshold
// passes.

import type { Page, Response } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One console line, with where it came from — a message without its origin is
 *  a message you cannot act on. */
export type Note = { kind: string; text: string; where: string };

/** A sample of the transcript, taken in the page.
 *
 *  `chars` is the TOTAL text length across every message, not the last one's:
 *  the first run of this recorder read the last `.message` and watched it sit
 *  frozen through a forty-second answer, because what is last in traversal
 *  order is not what is growing. The total is indifferent to ordering — any
 *  paint anywhere in the transcript grows it — so its growth curve IS the
 *  stream, whichever element the stream lands in. `busy` is whether the
 *  loading skeleton is on screen, which is the component's own definition of
 *  "still answering". */
export type Sample = { t: number; n: number; chars: number; busy: boolean };

export type Turn = {
  said: string;
  /** Wall time from pressing Enter to the last change in the transcript. */
  ms: number;
  /** Every sample taken while this turn was answering. */
  samples: Sample[];
  /** What the assistant ended up saying, trimmed to something readable. */
  answer: string;
  /** Fenced code blocks the markdown renderer produced, by language. */
  code: { lang: string; lines: number; highlighted: number; copy: boolean }[];
  /** What the status line said while the turn was in flight, in order. */
  status: string[];
};

export type Report = {
  url: string;
  who: string;
  turns: Turn[];
  notes: Note[];
  /** Uncaught exceptions, with the stack — the single most useful thing here
   *  and the one a screenshot can never show. */
  crashes: { text: string; stack: string }[];
  /** Requests the browser gave up on, and responses the server refused. */
  netfail: { url: string; why: string }[];
  http: { url: string; status: number }[];
  /** `nr-icon` elements that drew no `<svg>` — the console's own rule, checked
   *  after a real conversation rather than on an empty page. */
  blankIcons: string[];
  /** True when the document scrolls sideways, which it never should. */
  sideways: boolean;
  /** The rail's title for this conversation, to catch a thread named after the
   *  agent rather than after what the person typed. */
  railTitle: string;
};

/** Walk open shadow roots. Every region here is a custom element, so a plain
 *  querySelectorAll stops at the first boundary and finds a fraction of the
 *  page — which reads as a feature that is missing rather than as a search
 *  that did not go deep enough. Written as source text because it is injected
 *  into the page, where this module's imports do not exist.
 *
 *  `transcript()` is the scoped version, and the scoping is a lesson: an
 *  unscoped `.message` walk also matches things that are not turns — and
 *  matches them in traversal order, which is not screen order. Everything that
 *  reads the conversation goes through the chatbot's own `.messages` list. */
const WALK = `
  function deepAll(sel, root, depth) {
    root = root || document; depth = depth || 0;
    var out = [];
    if (depth > 16) { return out; }
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.matches(sel)) { out.push(el); }
      if (el.shadowRoot) { out = out.concat(deepAll(sel, el.shadowRoot, depth + 1)); }
    }
    return out;
  }
  function transcript() {
    var bot = deepAll("nr-chatbot")[0];
    var box = bot && bot.shadowRoot ? bot.shadowRoot.querySelector(".messages") : null;
    return box ? [].slice.call(box.querySelectorAll(".message")) : [];
  }
`;

/** Start recording. Call before the first navigation: the sampler is an init
 *  script so it survives the reload a sign-in causes, and the listeners have
 *  to predate the first request to see it. */
export async function record(page: Page): Promise<Report> {
  const report: Report = {
    url: "", who: "", turns: [], notes: [], crashes: [],
    netfail: [], http: [], blankIcons: [], sideways: false, railTitle: "",
  };

  page.on("console", (m) => {
    const at = m.location();
    report.notes.push({
      kind: m.type(),
      text: m.text().slice(0, 400),
      where: at.url === "" ? "" : `${at.url}:${at.lineNumber}`,
    });
  });
  page.on("pageerror", (e) => {
    report.crashes.push({ text: e.message, stack: (e.stack ?? "").slice(0, 1200) });
  });
  page.on("requestfailed", (r) => {
    report.netfail.push({ url: r.url(), why: r.failure()?.errorText ?? "?" });
  });
  page.on("response", (r: Response) => {
    if (r.status() >= 400) { report.http.push({ url: r.url(), status: r.status() }); }
  });

  // The sampler. 25ms is chosen against what it is measuring: the console's
  // own reveal loop runs at 33ms, so sampling faster than that cannot miss a
  // paint, and a turn of a minute costs 2400 numbers — small enough to keep
  // whole rather than summarise in the page, where a bug in the summary would
  // be invisible.
  await page.addInitScript(`
    ${WALK}
    window.__rec = { samples: [], status: [] };
    setInterval(function () {
      var msgs = transcript();
      var total = 0, busy = false;
      for (var i = 0; i < msgs.length; i++) {
        total += (msgs[i].textContent || "").length;
        if (msgs[i].classList.contains("loading")) { busy = true; }
      }
      window.__rec.samples.push({
        t: Math.round(performance.now()),
        n: msgs.length,
        chars: total,
        busy: busy,
      });
      // Whatever the console is currently calling the running round. Recorded
      // as a set in order of first appearance, so a status that never changes
      // is as visible as one that changes per tool.
      var s = deepAll(".steps-title, .working, .status-line")[0];
      var said = s ? (s.textContent || "").trim().slice(0, 80) : "";
      var seen = window.__rec.status;
      if (said !== "" && seen[seen.length - 1] !== said) { seen.push(said); }
    }, 25);
  `);

  return report;
}

/** Empty the sampler's buffer and hand back what was in it. */
export async function drain(page: Page): Promise<{ samples: Sample[]; status: string[] }> {
  return await page.evaluate(() => {
    const w = window as unknown as { __rec?: { samples: Sample[]; status: string[] } };
    const held = w.__rec ?? { samples: [], status: [] };
    const out = { samples: held.samples.slice(), status: held.status.slice() };
    held.samples.length = 0;
    held.status.length = 0;
    return out;
  });
}

/** The fenced code blocks on screen, as the renderer left them.
 *
 *  `highlighted` counts the spans the highlighter produced. Zero of them in a
 *  block that has a language is the exact shape of "the fence was recognised
 *  and the colouring was not", which is invisible in a screenshot taken at the
 *  wrong moment and obvious as a number. */
export async function codeBlocks(page: Page): Promise<Turn["code"]> {
  return await page.evaluate(`(function () {
    ${WALK}
    // The console's own card shape (src/markdown.ts emitBlock): a bordered div
    // holding a header — an eyebrow span naming the language, then a
    // button[data-copy-card] carrying the exact text — and the pre>code under
    // it. The attribute is on the BUTTON; the first draft of this reader
    // looked for a data-copy-card ancestor and reported every copy button on
    // screen as missing.
    return deepAll("pre > code").map(function (code) {
      var pre = code.parentElement;
      var card = pre ? pre.parentElement : null;
      var button = card ? card.querySelector("button[data-copy-card]") : null;
      var eyebrow = card ? card.querySelector("span") : null;
      return {
        lang: eyebrow ? (eyebrow.textContent || "").trim().toLowerCase() : "",
        lines: (code.textContent || "").split("\\n").length,
        highlighted: code.querySelectorAll("span").length,
        copy: !!button,
      };
    });
  })()`) as Turn["code"];
}

/** Icons that drew nothing, and the layout's one hard rule. */
export async function chrome(page: Page): Promise<{ blankIcons: string[]; sideways: boolean }> {
  return await page.evaluate(`(function () {
    ${WALK}
    var blank = deepAll("nr-icon").filter(function (el) {
      return !(el.shadowRoot && el.shadowRoot.querySelector("svg")) && !el.querySelector("svg");
    }).map(function (el) { return el.getAttribute("name") || "(unnamed)"; });
    var d = document.documentElement;
    return { blankIcons: blank, sideways: d.scrollWidth > d.clientWidth + 1 };
  })()`) as { blankIcons: string[]; sideways: boolean };
}

/** Read the page, tolerating the page going away underneath.
 *
 *  Every reader below is called from inside `expect.poll`, and a poll that
 *  straddles a navigation — which signing in is — gets "Execution context was
 *  destroyed" from an evaluate that was perfectly correct a frame earlier.
 *  Thrown, that ends the whole run at the sign-in; swallowed, the next poll
 *  reads the new document and continues. Only THIS class of error is
 *  swallowed: anything else is a real failure and is re-thrown.
 *
 *  `fallback` is what the caller should see for "the page is between
 *  documents", which for every reader here is the same as "nothing yet". */
async function reading<T>(page: Page, script: string, fallback: T): Promise<T> {
  try {
    return await page.evaluate(script) as T;
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    if (/Execution context was destroyed|Target closed|Most likely the page has been closed/i.test(said)) {
      return fallback;
    }
    throw e;
  }
}

/** Where the conversation stands right now — one read, for the spec's wait.
 *  `bots` counts finished assistant turns; `busy` is the skeleton. */
export async function probe(page: Page): Promise<{ total: number; bots: number; busy: boolean }> {
  return await reading(page, `(function () {
    ${WALK}
    var msgs = transcript();
    var total = 0, bots = 0, busy = false;
    for (var i = 0; i < msgs.length; i++) {
      total += (msgs[i].textContent || "").length;
      if (msgs[i].classList.contains("loading")) { busy = true; }
      else if (msgs[i].classList.contains("bot")) { bots += 1; }
    }
    return { total: total, bots: bots, busy: busy };
  })()`, { total: 0, bots: 0, busy: false });
}

/** What the newest finished assistant message says. Read from the chatbot's
 *  own list, newest last — the unscoped version of this read once answered
 *  with a timestamp. */
export async function lastAnswer(page: Page): Promise<string> {
  return await reading(page, `(function () {
    ${WALK}
    var msgs = transcript().filter(function (m) {
      return m.classList.contains("bot") && !m.classList.contains("loading");
    });
    var last = msgs[msgs.length - 1];
    if (!last) { return ""; }
    var body = last.querySelector(".message__content") || last;
    return (body.textContent || "").trim();
  })()`, "");
}

/** Deep text of the first match, for the handful of single facts worth reading
 *  off the page rather than sampling. */
export async function deepText(page: Page, sel: string): Promise<string> {
  return await reading(page, `(function () {
    ${WALK}
    var el = deepAll(${JSON.stringify(sel)})[0];
    return el ? (el.textContent || "").trim() : "";
  })()`, "");
}

// --- scoring -----------------------------------------------------------------

export type Finding = { check: string; ok: boolean; detail: string };

/** How a stream arrived, from the growth curve.
 *
 *  A reveal that lands token by token climbs in many small steps; one that
 *  lands in poll-sized slabs climbs in a few large ones. The number that tells
 *  them apart is the biggest single jump as a share of the whole answer: a
 *  quarter of a reply appearing between two frames 25ms apart is not a stream,
 *  whatever the transport underneath is doing. */
export function stream(t: Turn): { steps: number; biggest: number; share: number; grown: number } {
  // The samples carry the transcript's total, so the turn's own growth is
  // measured against its first sample — what was on screen before this turn
  // is baseline, not stream. The first step is exempt from "biggest": it
  // contains the person's own message landing, which arrives whole by nature.
  const start = t.samples.length === 0 ? 0 : t.samples[0].chars;
  let steps = 0, biggest = 0, last = start, end = start;
  for (const s of t.samples) {
    if (s.chars > last) {
      steps += 1;
      if (steps > 1 && s.chars - last > biggest) { biggest = s.chars - last; }
      last = s.chars;
    }
    end = Math.max(end, s.chars);
  }
  const grown = end - start;
  return { steps, biggest, share: grown === 0 ? 0 : biggest / grown, grown };
}

/** Turn a recording into findings. Thresholds live here and nowhere else. */
export function score(r: Report): Finding[] {
  const out: Finding[] = [];
  const say = (check: string, ok: boolean, detail: string) => out.push({ check, ok, detail });

  say("no uncaught exceptions", r.crashes.length === 0,
    r.crashes.map((c) => c.text).join(" | ") || "none");

  // Warnings are not failures — a component library talks. Errors are.
  const errs = r.notes.filter((n) => n.kind === "error");
  say("no console errors", errs.length === 0,
    errs.slice(0, 6).map((e) => `${e.text} @ ${e.where}`).join(" | ") || "none");

  say("no failed requests", r.netfail.length === 0,
    r.netfail.slice(0, 6).map((f) => `${f.why} ${f.url}`).join(" | ") || "none");

  // A 401 on /whoami is how the console asks whether anyone is signed in, so
  // it is expected and not a fault. Everything else is.
  const bad = r.http.filter((h) => !(h.status === 401 && h.url.includes("/whoami")));
  say("no HTTP errors", bad.length === 0,
    bad.slice(0, 8).map((h) => `${h.status} ${h.url}`).join(" | ") || "none");

  say("every icon drew", r.blankIcons.length === 0,
    r.blankIcons.length === 0 ? "none blank" : [...new Set(r.blankIcons)].join(", "));

  say("no sideways scroll", !r.sideways, r.sideways ? "document scrolls sideways" : "clean");

  for (const [i, t] of r.turns.entries()) {
    const s = stream(t);
    // A third of the answer in one frame is the line. Below it the reveal is
    // doing its job; above it, whatever the wire is doing, the screen is not
    // streaming.
    say(`turn ${i + 1} streams`, s.share <= 0.34 && s.steps >= 8,
      `${s.steps} steps, biggest ${s.biggest} chars (${Math.round(s.share * 100)}% of answer), ${t.ms}ms`);
    say(`turn ${i + 1} answered`, t.answer.length > 0, `${t.answer.length} chars`);
  }

  const withCode = r.turns.flatMap((t) => t.code);
  if (withCode.length > 0) {
    // "code" is the eyebrow's word for a fence with no info string — nothing
    // to highlight by, so nothing to hold against the highlighter.
    const dark = withCode.filter((c) => c.lang !== "" && c.lang !== "code" && c.highlighted === 0);
    say("code blocks are highlighted", dark.length === 0,
      dark.length === 0 ? `${withCode.length} blocks coloured` : `${dark.length} plain: ${dark.map((c) => c.lang).join(", ")}`);
    say("code blocks offer copy", withCode.every((c) => c.copy),
      `${withCode.filter((c) => c.copy).length}/${withCode.length}`);
  }

  say("conversation is named after what was asked", r.railTitle !== "" &&
    !/^a-|assistant$/i.test(r.railTitle), r.railTitle || "(empty)");

  return out;
}

export function save(path: string, r: Report): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2));
}

// What the chat pane talks to.
//
// `nr-chatbot` sends nothing on its own: Enter calls `controller.sendMessage`,
// and with no controller attached it logs a warning and returns. From the
// outside that is silent — the composer accepts text, the message disappears,
// nothing reaches the network. That was this console's state, and no test
// caught it because none of them ever sent a message.
//
// The library ships a ChatbotCoreController with providers, plugins, storage
// and its own thread and message stores. Adopting it would have put a second
// owner of "which conversation is open and what is in it" beside the one the
// console already has in its sidebar — and two stores of the same fact drift
// the first time one of them is wrong. So this is the whole contract the
// component actually uses, and nothing else:
//
//   on(event, fn) -> unsubscribe   getState()   sendMessage(text, opts)
//   clearFiles()
//
// Everything else the component reaches for — switchThread, createThread,
// uploadFiles, stop — it calls with `?.`, so leaving them out is a supported
// shape rather than a gap. When this console grows file upload or a stop
// button, they get added here deliberately.

// TranscriptTurn is imported and not merely referenced: `apply` names it in
// its signature, and without the import that name resolved to nothing — a
// pre-existing TS2304 in this file, and the only thing standing between it and
// a clean check.
import { LiveStep, RoundSteps, Thought, TranscriptTurn, TurnArtifactRef, WireRef, artifactsByTurn, openThread, say, threadSteps, transcript, uploadFileArtifact } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { renderWithCards } from "./cards.js";
import * as live from "./live.js";
import { diffLines } from "./diff.js";
import hljs from "highlight.js/lib/core";
import hljsPython from "highlight.js/lib/languages/python";
import hljsJavascript from "highlight.js/lib/languages/javascript";
import hljsBash from "highlight.js/lib/languages/bash";

// The three languages run_script speaks. hljs escapes every character of the
// source and wraps tokens in its own spans, so the highlighted string is as
// inert as the escapeHtml it replaces — the colours come from the stylesheet
// the console hands nr-chatbot's shadow root.
hljs.registerLanguage("python", hljsPython);
hljs.registerLanguage("javascript", hljsJavascript);
hljs.registerLanguage("bash", hljsBash);

function highlighted(source: string, language: string): string {
  const name = language === "python" ? "python" : language === "node" ? "javascript" : "bash";
  try {
    return hljs.highlight(source, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(source);
  }
}

export type ChatMessage = {
  id: string;
  sender: "user" | "bot";
  text: string;
  timestamp: string;
  // The artifacts this turn saved, as slot@version references. The component
  // does not read this property; the console does, to draw its own cards.
  refs: WireRef[];
  error?: boolean;
};

// Every body this session hands the component goes through here first. The
// component renders message text with unsafeHTML in both of its branches
// (message.template.ts), so unescaped markup in a reply — or in a document a
// reply quotes — would become part of the console's own origin, with the
// session cookie and the whole /api surface behind it. The session is the last
// owner of the raw string on both paths, live sends and open()'s transcript
// reload (which bypasses the plugins entirely), so escaping lives here and not
// in a plugin that one of the two paths never runs. Character loop, not
// replace(): the house style bans RegExp, and chained split/join reads worse.
function escapeHtml(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#39;";
    else out += ch;
  }
  return out;
}


// The card, as markup that travels inside a message.
//
// It belongs beside the turn it describes, not in a strip at the bottom of the
// pane — a conversation with four answers has four sets of calls, and a single
// card at the edge cannot say which is which. nr-chatbot owns message rendering
// and offers no slot between messages, but it renders a message's text with
// unsafeHTML, so the card rides inside the message it belongs to.
//
// Which puts the escaping burden here: a tool name, its arguments and a child
// agent's id all originate outside this console, and every one of them is
// escaped below. The styles are inline because the component renders into a
// shadow root the console's stylesheet does not cross.
// A min-width, not a width. The card sits inside a message bubble that
// shrink-wraps its content, so `width:100%` resolves against a box that is
// already as narrow as the card — and a round that has only started thinking
// collapsed to the width of the word "thinking". A minimum makes the bubble
// grow instead, and it holds steady as calls appear underneath.
// max-width pins the card to the column it sits in. Its min-width asks for
// 560px, which a narrow panel cannot give, and a min-width larger than the
// space available is a card wider than the conversation — the arguments then
// run off the right edge of the window with no way to scroll to them.
const CARD = "border:1px solid rgba(0,0,0,.12);border-radius:10px;margin:0 0 10px;"
  + "overflow:hidden;font-size:13px;min-width:min(560px,72vw);max-width:100%";
const HEAD = "display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:500";
// min-width:0 on the row as well as on the arguments. A flex item defaults to
// min-width:auto — "never shrink below your content" — so a nowrap line of
// JSON pushes the row wider than the card however much overflow:hidden the
// span carries. The ellipsis only appears once the span is allowed to be
// narrower than the text it holds.
const ROW = "display:flex;gap:8px;padding:6px 12px;align-items:baseline;min-width:0";
const NAME = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:none";
const ARGS = "flex:1;min-width:0;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace";
const MS = "opacity:.55;font-variant-numeric:tabular-nums";

const THINK = "padding:6px 12px;border-top:1px solid rgba(0,0,0,.06)";
const THINK_TEXT = "margin:.4rem 0 .2rem;white-space:pre-wrap;opacity:.7;font-size:12.5px";
const DIFF = "margin:.35rem 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;"
  + "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:16rem;overflow:auto";

// The fields an edit step stores, or null when the row is not that shape —
// an old round's row, or a fallback prefix — in which case the raw preview is
// shown as it always was.
function editFields(args: string): { path: string; added: number; removed: number; line: number; old: string; new: string; cut: boolean } | null {
  try {
    const p = JSON.parse(args) as Record<string, unknown>;
    if (typeof p.path !== "string" || typeof p.old !== "string" || typeof p.new !== "string") return null;
    return {
      path: p.path, old: p.old, new: p.new,
      added: typeof p.added === "number" ? p.added : 0,
      removed: typeof p.removed === "number" ? p.removed : 0,
      // Where the edit landed in the artifact, 1-based; 0 on rows stored
      // before the field existed, which renders as no numbers at all.
      line: typeof p.line === "number" ? p.line : 0,
      cut: p.cut === true,
    };
  } catch { return null; }
}

// The edit as one unified block: every old line a signed − row, every new
// line a + row, lines the edit kept drawn once and unsigned — the shape a
// reviewer already knows. Numbers are the artifact's own, from the line the
// edit landed on; an old row stored before that field renders unnumbered.
function unifiedEdit(edit: { old: string; new: string; line: number }): string {
  const rows = diffLines(edit.old, edit.new) ?? [];
  const base = edit.line > 0 ? edit.line - 1 : 0;
  const gut = (n: number) => edit.line > 0 && n > 0 ? String(base + n) : "";
  const row = (bg: string, sign: string, signColor: string, num: string, text: string) =>
    `<div style="display:flex;align-items:baseline;${bg}">`
    + `<span style="flex:none;min-width:26px;text-align:right;padding-right:6px;opacity:.5;`
    + `font-size:11px;user-select:none;font-variant-numeric:tabular-nums">${num}</span>`
    + `<span style="flex:none;width:14px;text-align:center;user-select:none;color:${signColor}">${sign}</span>`
    + `<span style="flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding-right:8px">${escapeHtml(text)}</span></div>`;
  const body = rows.map((r) =>
    r.kind === "del" ? row("background:rgba(179,56,46,.10)", "−", "#b3382e", gut(r.a), r.text)
    : r.kind === "add" ? row("background:rgba(47,138,76,.10)", "+", "#2f8a4c", gut(r.b), r.text)
    : row("", "", "", gut(r.a), r.text)).join("");
  return `<div style="${DIFF};padding:6px 0">${body}</div>`;
}

// A script step's landings: the args preview plus what the reconcile
// changed, or null for rows stored before the field existed — those render
// the raw preview as they always did.
// What a failed call answered, when the row kept it. The server caps the
// text; this only dresses it.
function failureNote(s: LiveStep): string {
  if (s.running || s.ok || !s.result) return "";
  return `<pre style="${DIFF};border-left:3px solid #b3261e">${escapeHtml(s.result)}</pre>`;
}

function scriptFields(args: string): { language: string; paths: string[]; source: string; cut: boolean; changed: { path: string; version: number }[] } | null {
  try {
    const p = JSON.parse(args) as Record<string, unknown>;
    if (typeof p.source !== "string" || !Array.isArray(p.changed)) return null;
    return {
      language: typeof p.language === "string" ? p.language : "",
      paths: Array.isArray(p.paths) ? p.paths as string[] : [],
      source: p.source, cut: p.cut === true,
      changed: p.changed as { path: string; version: number }[],
    };
  } catch { return null; }
}

// The skill a use_skill step loaded, or null when the args are not that
// shape. The member is "name" — the tool's schema calls it that.
function skillFields(args: string): { name: string } | null {
  try {
    const p = JSON.parse(args) as Record<string, unknown>;
    if (typeof p.name !== "string" || p.name === "") return null;
    return { name: p.name };
  } catch { return null; }
}

/* The turn's saves, as cards on the message itself — the same shape as the
   attach cards beside the composer, so a file the model wrote reads like a
   file a person handed over. Inline styles for the same reason every card in
   here carries them: this markup lands inside nr-chatbot's shadow root, where
   the console's stylesheets cannot reach.
   Clickable through the same delegated path as the diff chips: the click
   bubbles composed out of the shadow root and the console reads the data
   attributes off it (chipClick). */
export function refCards(refs: WireRef[]): string {
  if (!refs || refs.length === 0) return "";
  const cards = refs.map((r) => {
    const name = r.path.split("/").filter((p) => p !== "").pop() ?? r.path;
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "file";
    return `<span data-open-path="${escapeHtml(r.path)}" data-open-version="${r.version}"` +
      ` style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;` +
      `padding:8px 14px;border:1px solid rgba(0,0,0,.13);border-radius:14px;background:#fff;` +
      `cursor:pointer;max-width:260px">` +
      `<span style="font-weight:600;font-size:13.5px;color:rgba(0,0,0,.85);max-width:230px;` +
      `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>` +
      `<span style="font-size:11.5px;color:rgba(0,0,0,.45)">${ext} · v${r.version}</span></span>`;
  }).join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">${cards}</div>`;
}

export function stepsCard(steps: LiveStep[], thoughts: Thought[] = []): string {
  if (steps.length === 0 && thoughts.length === 0) return "";
  const running = steps.filter((s) => s.running).length;
  // "working" rather than "thinking" while there is nothing to count: the block
  // below already says thinking, and a card headed by the same word it repeats
  // reads as a mistake.
  const head = steps.length === 0
    ? "working"
    : (running > 0
      ? `${steps.length} ${steps.length === 1 ? "call" : "calls"}, ${running} running`
      : `${steps.length} ${steps.length === 1 ? "call" : "calls"} done`);

  // Grouped by rotation, because one message is not one exchange: the model
  // calls tools, reads the results, and may call more before it answers. A flat
  // list says it asked for all of them at once.
  const rounds = new Map<number, LiveStep[]>();
  for (const s of steps) rounds.set(s.rotation, [...(rounds.get(s.rotation) ?? []), s]);
  // A rotation can think and call nothing — the last one usually does, since it
  // stops calling and answers. It still deserves its place in the order.
  for (const t of thoughts) if (!rounds.has(t.rotation)) rounds.set(t.rotation, []);
  // Keyed by rotation *and* depth: within one rotation the agent thinks, and so
  // does any sub-agent it asks, and the two are different voices.
  const thinking = new Map<string, Thought[]>();
  for (const t of thoughts) {
    const key = `${t.rotation}`;
    thinking.set(key, [...(thinking.get(key) ?? []), t]);
  }

  let body = "";
  for (const [rotation, calls] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
    if (rounds.size > 1) {
      body += `<div style="${ROW};opacity:.5">exchange ${rotation + 1}</div>`;
    }
    for (const thought of (thinking.get(`${rotation}`) ?? [])) {
      // Collapsed by default: it is context for a person who wants it, not the
      // answer, and an open block of reasoning above every reply buries the
      // reply.
      const who = thought.depth > 0 ? "the sub-agent is thinking" : "thinking";
      const pad = thought.depth > 0 ? `padding-left:${12 + thought.depth * 18}px;` : "";
      body += `<details style="${THINK};${pad}"><summary style="cursor:pointer;opacity:.6">${who}</summary>`
        + `<div style="${THINK_TEXT}">${escapeHtml(thought.text)}</div></details>`;
    }
    for (const s of calls) {
      // The mark carries its verdict in color as well as shape: a check is
      // only reassuring when it is visibly not a cross at a glance.
      const mark = s.running ? "&#8230;"
        : s.ok ? '<span style="color:#2f8a4c">&#10003;</span>'
        : '<span style="color:#b3261e">&#10007;</span>';
      const took = s.running ? "" : `${s.millis}ms`;
      // Indented by depth, so a sub-agent's calls read as belonging to the
      // delegation above them rather than as more of the parent's own work.
      const indent = s.depth > 0 ? `padding-left:${12 + s.depth * 18}px;` : "";
      // An edit gets a sentence, not its raw arguments: "Edited <path> +a -r",
      // opening into the old and new text. The row stores those as fields.
      const edit = s.name === "edit_artifact" ? editFields(s.args) : null;
      if (edit) {
        body += `<details class="tool-call edit" style="${indent}">`
          + `<summary style="${ROW};cursor:pointer;list-style:none"><span>${mark}</span>`
          + `<span class="tool-name" style="${NAME}">Edited ${escapeHtml(edit.path)}</span>`
          + `<span style="flex:1"><span style="color:#2f8a4c">+${edit.added}</span>`
          + ` <span style="color:#b3382e">-${edit.removed}</span></span>`
          + `<span class="tool-ms" style="${MS}">${took}</span></summary>`
          + `<div style="padding:0 12px 8px">`
          + unifiedEdit(edit)
          + (edit.cut ? `<div style="opacity:.55;font-size:11.5px">cut — the whole text is in the artifact's history</div>` : "")
          + `</div></details>`;
        continue;
      }
      // A skill load reads as what it did, not as raw JSON. One row, no body
      // to expand: a step carries its arguments, and the loaded instructions
      // are a tool result the card never holds.
      const skill = s.name === "use_skill" ? skillFields(s.args) : null;
      if (skill) {
        body += `<div class="tool-call skill" style="${ROW};${indent}"><span>${mark}</span>`
          + `<span class="tool-name" style="${NAME}">Used skill ${escapeHtml(skill.name)}</span>`
          + `<span style="flex:1"></span>`
          + `<span class="tool-ms" style="${MS}">${took}</span></div>`;
        continue;
      }
      // A script row is a sentence that opens: the summary says what ran and
      // what it landed, the expansion is the program itself — the Claude Code
      // reading. Chips open the panel's diff for each landed version; the
      // console delegates their clicks, nothing here holds a handler.
      const script = s.name === "run_script" ? scriptFields(s.args) : null;
      if (script) {
        const chips = script.changed.map((c) =>
          `<button data-diff-path="${escapeHtml(c.path)}" data-diff-version="${c.version}"`
          + ` style="border:1px solid rgba(47,138,76,.4);background:rgba(47,138,76,.08);color:#2f8a4c;`
          + `border-radius:999px;padding:0 8px;font:11px ui-monospace,monospace;cursor:pointer;flex:none">`
          + `${escapeHtml(c.path)} v${c.version}</button>`).join(" ");
        const what = `Ran ${escapeHtml(script.language || "script")}`
          + (script.paths.length > 0 ? ` on ${script.paths.map(escapeHtml).join(", ")}` : "");
        body += `<details class="tool-call script" style="${indent}">`
          + `<summary style="${ROW};cursor:pointer;list-style:none"><span>${mark}</span>`
          + `<span class="tool-name" style="${NAME}">${what}</span>`
          + `<span style="flex:1;min-width:0"></span>`
          + chips
          + `<span class="tool-ms" style="${MS}">${took}</span></summary>`
          + `<div style="padding:0 12px 8px">`
          + `<pre style="${DIFF}">${highlighted(script.source, script.language)}</pre>`
          + (script.cut ? `<div style="opacity:.55;font-size:11.5px">cut — the run executed the whole script</div>` : "")
          + failureNote(s)
          + `</div></details>`;
        continue;
      }
      const detail = s.kind === "agent" ? s.target : s.args;
      // A failed call with a stored reply opens: the row alone says only that
      // it failed, and "why" was the one question the card could not answer.
      if (!s.running && !s.ok && s.result) {
        body += `<details class="tool-call failed" style="${indent}">`
          + `<summary style="${ROW};cursor:pointer;list-style:none"><span>${mark}</span>`
          + `<span class="tool-name" style="${NAME}">${escapeHtml(s.name)}</span>`
          + `<span style="${ARGS}">${escapeHtml(detail)}</span>`
          + `<span class="tool-ms" style="${MS}">${took}</span></summary>`
          + `<div style="padding:0 12px 8px">${failureNote(s)}</div></details>`;
        continue;
      }
      body += `<div class="tool-call" style="${ROW};${indent}"><span>${mark}</span>`
        + `<span class="tool-name" style="${NAME}">${escapeHtml(s.name)}</span>`
        + `<span style="${ARGS}">${escapeHtml(detail)}</span>`
        + `<span class="tool-ms" style="${MS}">${took}</span></div>`;
    }
  }
  return `<div class="tool-card" style="${CARD}"><div class="tool-card-head" style="${HEAD}">${head}</div>${body}</div>`;
}

// What a waiting question wears until its turn comes. Markup rather than a
// field on the message, because nr-chatbot renders the text and knows nothing
// about this console's own notions.
const QUEUED_MARK = '<span class="queued" style="margin-left:.5rem;opacity:.55;font-size:.85em">waiting</span>';

function stripQueued(text: string): string {
  const at = text.indexOf(QUEUED_MARK);
  return at < 0 ? text : text.slice(0, at) + text.slice(at + QUEUED_MARK.length);
}

type Listener = (payload: unknown) => void;

// Shared empties, so the two lists this session never fills keep one identity
// for the lifetime of the page rather than a new one per read.
const EMPTY: never[] = [];

// What the session needs from the console, and what it hands back. The console
// still owns threads — it lists them, it decides which agent a new one opens
// against, and it opens one lazily because an empty conversation nobody typed
// into is not worth a row.
export type SessionBridge = {
  agentId: () => string;
  // What the composer's picker is showing right now, "" for the agent's own
  // model. Read at the moment a question is accepted rather than held here,
  // for the same reason the agent is: the console owns the control, and a copy
  // in this session would be a second answer to which model the next message
  // runs on.
  modelChoiceId: () => string;
  onThreadOpened: (threadId: string) => void;
  onTurnDone: () => void;
  // How many free messages this guest has left today, straight off the say
  // reply. Optional twice over: the console only wires it when there is a
  // strip to update, and the reply only carries the number for guest callers
  // — a signed-in reply has no member, and this is never called.
  onGuestRemaining?: (remaining: number) => void;
};

// What the composer's tray shows for an attached file. The shape nr-chatbot
// reads from state.uploadedFiles; the bytes are already in the artifact
// store and never ride this record.
// What the empty state offers, Kimi-style: one pill per thing this console
// is actually for. Clicking one sends its text as the first message.
// One frozen empty array, not a fresh `[]` per call: this is read on the render
// path and a new identity every time is what pegged this tab once already.
const EMPTY_SUGGESTIONS: { id: string; text: string; icon?: string }[] = [];

const SUGGESTIONS = [
  { id: "s-validate", text: "Validate the docflow I attached" },
  { id: "s-repair", text: "Repair my docflow until the validator passes" },
  { id: "s-enums", text: "What are the legal values of QueryOperator?" },
  { id: "s-convert", text: "Convert my docflow's distribution from email to SMS" },
];

export type TrayFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  mimeType: string;
  uploadProgress: number;
};

export class ChatSession {
  private listeners = new Map<string, Set<Listener>>();
  private threadId = "";

  // One state object, replaced only when something in it actually changed.
  //
  // getState() used to build a fresh object with fresh arrays on every call.
  // The component assigns `this.messages = state.messages` whenever it reads
  // state, so a new array reference each time meant a changed property, which
  // meant another render, which read state again — the tab pegged and the page
  // never finished loading. Identity is the contract here, not just contents.
  // What the run is doing, refreshed while the send is outstanding. Held on
  // the session rather than in the component's state, because nr-chatbot
  // renders messages and knows nothing about tool calls — the console draws
  // these itself and asks for them here.
  // Questions asked but not yet sent, oldest first, each with the message that
  // is already on screen for it and the model choice that was showing when it
  // was typed. The choice is captured here rather than read at send time
  // because the selection travels WITH THE MESSAGE: a person who asks
  // something on Fast, changes the picker, and asks something else while the
  // first is still running meant each of those two, and answering both on
  // whatever the picker last showed would be a different conversation.
  private pending: { id: string; said: string; choiceId: string }[] = [];
  /* The exact text a slash pick wrote into the composer, so the next send can
     take that and only that back off the front. Set by the console when a
     skill is chosen from the slash menu, cleared by the send that consumes it
     — and by any send at all, because a person who deleted it by hand should
     not have the next message trimmed. */
  slashPrefix = "";
  private live: LiveStep[] = [];
  private thoughts: Thought[] = [];
  private polling = 0;
  // The placeholder turn the card is drawn into while the round runs.
  private liveId = "";

  private state: {
    messages: ChatMessage[];
    threads: never[];
    suggestions: { id: string; text: string; icon?: string }[];
    isProcessing: boolean;
    isTyping: boolean;
    uploadedFiles: TrayFile[];
  } = {
    messages: [],
    threads: EMPTY,
    suggestions: SUGGESTIONS,
    isProcessing: false,
    isTyping: false,
    uploadedFiles: [],
  };

  constructor(private readonly bridge: SessionBridge) {
    // Rounds, pushed. The server watches whichever conversation this browser
    // said it is looking at and forwards the step rows as they land, at the
    // same 400ms the client used to ask at — the polling moved to the machine
    // next to the engine rather than stopping. A round for a conversation
    // this session has since left is not this session's business.
    live.on("round", ({ threadId, round }) => {
      if (threadId !== this.threadId) return;
      this.ingest(round);
    });
  }

  // One round, from wherever it came: the feed, or the fallback timer below.
  //
  // Which of the two things to do with it is decided the way it was decided
  // when they were two separate timers. `watch()` ran only between setTyping
  // (true) and the reply, and painted the live card; `followTick()` bailed
  // while typing and adopted somebody else's run. So: our own turn in flight
  // takes the first path, everything else takes the second.
  private ingest(round: RoundSteps): void {
    if (this.state.isTyping) {
      // `watching` is what `polling !== 0` used to be: the reply has landed
      // and settled `live` from what the server recorded, so a late push must
      // not repaint over it.
      if (!this.watching) return;
      if (round.seq <= this.doneSeq) return;
      this.live = round.steps;
      this.thoughts = round.thoughts ?? [];
      this.paintLive();
      this.emit("steps:changed", round);
      return;
    }
    void this.follow(round);
  }

  // --- the contract nr-chatbot uses -----------------------------------------

  on(event: string, fn: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(event, set);
    return () => { set.delete(fn); };
  }

  getState() {
    // Suggestions are an empty-state prompt, not a toolbar. They exist to
    // answer "what can I ask this thing" before there is a conversation to
    // read, and once there is one they are noise between the message you sent
    // and the answer arriving — on a phone they took a third of the screen
    // while the agent was working.
    //
    // Computed here rather than cleared on send, because there are three ways
    // a conversation acquires messages — sending, opening one from the rail,
    // and a round restored after reload — and a `suggestions = []` in each is
    // three places to forget. The mutation is in place: the object identity
    // has to hold, or nr-chatbot re-renders the whole transcript on every
    // poll (see the note above `state`).
    // Off entirely for now, and at the source rather than by a CSS hide: what
    // is not in the state is not in the DOM, on the server or the client, so
    // there is nothing to flash before a rule catches it. Restore by putting
    // the messages.length === 0 ? SUGGESTIONS : ... ternary back.
    this.state.suggestions = EMPTY_SUGGESTIONS;
    return this.state;
  }

  // The calls of the round now running, or of the last one that ran. Never a
  // fresh array per call: getState() building fresh arrays every time pegged
  // this tab once already, and this is read on the same render path.
  steps(): LiveStep[] {
    return this.live;
  }

  // Ask what the run is doing, on a timer, until it stops running.
  //
  // POST /messages answers once, at the end, so this is the only way to see
  // inside a round; the server can answer it because it runs handlers on a
  // thread pool. A failure here is silent by design — a console that cannot
  // show a spinner is a much smaller problem than a send that fails because
  // the spinner could not be drawn.
  // The last round known to be over. The poll below asks for "the newest
  // round", and until the round just sent writes its first row, the newest
  // round IS the previous one — so without this, a fresh question wore the
  // old answer's card for the first few hundred milliseconds.
  private doneSeq = -1;

  // Whether a round of ours is in flight and its card is still ours to paint.
  // It used to be `polling !== 0` and nothing else; now the timer is only the
  // fallback, so the fact is held on its own.
  private watching = false;

  private watch(): void {
    if (this.polling !== 0 || this.threadId === "") return;
    this.watching = true;
    this.polling = window.setInterval(async () => {
      // The feed is painting this card. Asking as well would be two answers
      // to one question, and the slower one would sometimes win.
      if (live.fresh()) return;
      try {
        this.ingest(await threadSteps(this.threadId));
      } catch { /* the answer is still coming; the next tick asks again */ }
    }, 400);
  }

  private unwatch(): void {
    this.watching = false;
    if (this.polling === 0) return;
    window.clearInterval(this.polling);
    this.polling = 0;
  }

  // A question, whenever it is asked.
  //
  // It used to be dropped outright while a turn was running — `return` on
  // isTyping, no message, no warning — so an impatient second thought vanished
  // between the composer and the transcript. Now it goes on screen at once,
  // marked as waiting, and is sent when the turn in front of it ends. The
  // order the questions were asked in is the order they are answered in.
  async sendMessage(text: string): Promise<void> {
    // Take the slash command back out.
    //
    // Picking one writes "/make-sheet " into the composer so you can see what
    // you chose — the skill is pinned, but a pin with nothing in the box reads
    // as nothing having happened. What it must not do is travel: the model is
    // told which skill to run through the pin, and "/make-sheet write me a
    // budget" would put a command in the transcript as if it were English.
    //
    // Exactly what was inserted and nothing else. Not a pattern for
    // slash-words in general — a message that opens "/etc/hosts is missing" is
    // a sentence, and a rule loose enough to eat this one would eat that.
    const asked = this.slashPrefix !== "" && text.startsWith(this.slashPrefix)
      ? text.slice(this.slashPrefix.length)
      : text;
    this.slashPrefix = "";
    const said = asked.trim();
    if (said === "") return;

    const waiting = this.state.isTyping;
    // The raw text goes to the API; the escaped copy goes on screen. A user
    // pasting an HTML snippet to ask about it must see the snippet, not run it.
    const id = `u${this.state.messages.length}`;
    this.push({
      id, sender: "user",
      text: escapeHtml(said) + (waiting ? QUEUED_MARK : ""),
      refs: EMPTY,
    });
    this.pending.push({ id, said, choiceId: this.bridge.modelChoiceId() });
    this.emit("message:sent", { text: said });
    // The turn already running will take it on its way out.
    if (waiting) return;
    await this.drain();
  }

  // Send what is waiting, oldest first, until nothing is.
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      // It is being sent now, so it is no longer waiting.
      this.setMessages(this.state.messages.map((m) =>
        m.id === next.id ? { ...m, text: stripQueued(m.text) } : m));
      await this.turn(next.said, next.choiceId);
    }
  }

  private async turn(said: string, choiceId: string): Promise<void> {
    this.setTyping(true);

    try {
      await this.ensureThread();
      // A placeholder turn to hang the card on. The answer has not arrived, so
      // this is what the card attaches to while the calls are running; the
      // answer replaces its text when it lands.
      const liveId = `live-${this.state.messages.length}`;
      this.liveId = liveId;
      this.push({ id: liveId, sender: "bot", text: "", refs: EMPTY });

      this.watch();
      const reply = await say(this.threadId, said, choiceId);
      // The answer carries its own calls, so the card settles on what the
      // server recorded rather than on whatever the last poll tick caught.
      this.unwatch();
      this.doneSeq = Math.max(this.doneSeq, reply.seq);
      this.live = reply.steps ?? [];
      this.thoughts = reply.thoughts ?? [];
      this.emit("steps:changed", { seq: reply.seq, running: false, steps: this.live });
      this.liveId = "";
      // A refusal is an answer. The API says why in a sentence — no credential,
      // no such agent, a model it cannot reach — and that sentence belongs in
      // the transcript, where it can be read, rather than in an error toast.
      // The card and the answer are one message, so they cannot drift apart or
      // be read as belonging to different turns.
      let saved: WireRef[] = reply.refs ?? [];
      if (saved.length === 0 && reply.seq >= 0) {
        const rows = await artifactsByTurn(this.threadId).catch(() => [] as TurnArtifactRef[]);
        saved = rows.filter((r) => r.turnSeq === reply.seq)
          .map((r) => ({ slot: r.slot, version: r.version, path: r.path }));
      }
      this.replaceLive({
        id: reply.runId,
        sender: "bot",
        text: stepsCard(this.live, this.thoughts)
          + renderWithCards(reply.ok ? reply.text : reply.error, (s) => renderMarkdown(escapeHtml(s)))
          + refCards(saved),
        refs: reply.refs,
        error: !reply.ok,
      }, liveId);
      this.emit("message:received", { ok: reply.ok });
      // The reply is the strip's clock: server-counted after this run was
      // recorded, so the number a guest reads is the engine's, never an
      // optimistic decrement that drifts across two tabs.
      if (typeof reply.guestRemaining === "number") {
        this.bridge.onGuestRemaining?.(reply.guestRemaining);
      }
      this.bridge.onTurnDone();
    } catch (e) {
      const said2 = e instanceof Error ? e.message : String(e);
      this.push({
        id: `e${this.state.messages.length}`, sender: "bot",
        text: escapeHtml(said2), refs: EMPTY, error: true,
      });
      this.emit("error", { message: said2 });
    } finally {
      this.unwatch();
      this.setTyping(false);
    }
  }

  // The thread this conversation will be, created on first need. A first
  // message and a first upload knock on the same door; whichever arrives
  // first opens it, and the console hears about it either way.
  async ensureThread(): Promise<string> {
    if (this.threadId === "") {
      this.threadId = (await openThread(this.bridge.agentId())).id;
      live.watch(this.threadId);
      this.bridge.onThreadOpened(this.threadId);
    }
    return this.threadId;
  }

  // The composer's attach button. A file a person hands the conversation IS
  // an artifact — same store, same path rules as the panel's upload — created
  // the moment it is picked, so the model's next turn already lists it in the
  // briefing. The pill the tray draws is a receipt, not a payload: the send
  // that follows carries only words, because the file is already where the
  // agent looks.
  async uploadFiles(files?: File[]): Promise<TrayFile[]> {
    if (!files || files.length === 0) return [];
    await this.ensureThread();
    const made: TrayFile[] = [];
    for (const file of files) {
      await uploadFileArtifact(this.threadId, file);
      made.push({
        id: `f-${this.state.uploadedFiles.length + made.length}-${file.name}`,
        name: file.name, size: file.size, type: "document",
        mimeType: file.type || "application/octet-stream", uploadProgress: 100,
      });
    }
    this.state = { ...this.state, uploadedFiles: [...this.state.uploadedFiles, ...made] };
    this.emit("state:changed", this.state);
    return made;
  }

  // The tray empties after a send; the artifacts it pointed at stay, which is
  // the whole difference between a receipt and a payload.
  clearFiles(): void {
    if (this.state.uploadedFiles.length === 0) return;
    this.state = { ...this.state, uploadedFiles: [] };
    this.emit("state:changed", this.state);
  }

  // --- what the console drives ----------------------------------------------

  // --- following runs this client did not start -------------------------------

  // A conversation is not only driven from this composer: the API, an eval
  // script, or another person's tab can be running a turn right now. The
  // follower adopts such a run — placeholder turn, live card, then the stored
  // transcript when it ends — so opening a working conversation shows the
  // work, the way it does for the client that started it.
  private following = 0;

  private startFollowing(): void {
    this.stopFollowing();
    if (this.threadId === "") return;
    this.following = window.setInterval(() => { void this.followTick(); }, 2000);
  }

  private stopFollowing(): void {
    if (this.following === 0) return;
    window.clearInterval(this.following);
    this.following = 0;
  }

  // The last turn seq the transcript on screen actually holds. Not doneSeq:
  // that one is computed from step rows, and a round's steps close BEFORE its
  // turns are stored — an open() landing in that window knows the round is
  // over while the answer is not yet readable, and a follower comparing
  // against it goes permanently blind. The screen's own high-water mark is
  // the only honest baseline, and a reload that finds the turns still
  // missing simply tries again next tick.
  private renderedSeq = -1;

  private async followTick(): Promise<void> {
    // Our own send owns the screen; its 400ms watcher is already painting.
    if (this.state.isTyping || this.threadId === "") return;
    // The feed is following for us.
    if (live.fresh()) return;
    try {
      await this.follow(await threadSteps(this.threadId));
    } catch { /* the next tick asks again */ }
  }

  // Adopt a round this client did not start. Split out of the tick above so
  // the feed and the fallback do the identical thing with an identical round.
  //
  // Re-entrancy is guarded because the feed can deliver every 400ms while
  // this awaits a transcript: two overlapping runs would each push their own
  // placeholder and the conversation would grow a second empty bot turn.
  private folding = false;

  private async follow(round: RoundSteps): Promise<void> {
    if (this.folding) return;
    this.folding = true;
    try {
      if (round.running) {
        if (this.liveId === "") {
          const liveId = `follow-${this.state.messages.length}`;
          this.liveId = liveId;
          this.push({ id: liveId, sender: "bot", text: "", refs: EMPTY });
        }
        this.live = round.steps;
        this.thoughts = round.thoughts ?? [];
        this.paintLive();
        this.emit("steps:changed", round);
        return;
      }
      if (round.seq < 0 || round.seq <= this.renderedSeq) return;
      // A finished round the screen does not show yet.
      await this.open(this.threadId);
      if (round.seq > this.renderedSeq) {
        // The turns are still landing. Keep a placeholder with the round's
        // card on screen and ask again next tick.
        if (this.liveId === "") {
          const liveId = `follow-${this.state.messages.length}`;
          this.liveId = liveId;
          this.push({ id: liveId, sender: "bot", text: "", refs: EMPTY });
        }
        this.live = round.steps;
        this.thoughts = round.thoughts ?? [];
        this.paintLive();
        return;
      }
      this.liveId = "";
      this.emit("message:received", { ok: true });
      this.bridge.onTurnDone();
    } catch { /* the next round, pushed or polled, tries again */
    } finally { this.folding = false; }
  }

  /** Open an existing conversation and show its turns. */
  async open(threadId: string): Promise<void> {
    this.threadId = threadId;
    // Tell the server which conversation this browser is looking at; its
    // step and artifact polls follow that answer and nothing else.
    live.watch(threadId);
    this.startFollowing();
    // The turns and every round's calls and reasoning, together. A card is not
    // a live-only ornament: it is what the answer above it was made of, and a
    // reload that dropped it left the conversation claiming work it no longer
    // showed. Asked in parallel — the transcript does not depend on the steps.
    const [said, past, byTurn] = await Promise.all([
      transcript(threadId),
      threadSteps(threadId, "all").catch(() => ({ steps: [], thoughts: [] } as Pick<RoundSteps, "steps" | "thoughts">)),
      artifactsByTurn(threadId).catch(() => [] as TurnArtifactRef[]),
    ]);
    // Recorded, not applied. The follower re-opens a conversation whenever a
    // round it did not start finishes (`follow`), and applying the stored
    // choice from in here would snap the composer's picker back under the
    // hands of somebody who had just changed it and not yet sent. So the
    // session keeps the fact and the console decides when to adopt it — which
    // it does on an explicit open, and nowhere else.
    this.remembered = said.modelChoiceId;
    this.apply(said.messages, past, byTurn);
  }

  /** What this conversation last ran on, as of the last read of it. "" for the
   *  agent's own model, which is what every conversation opened before the
   *  picker existed carries. */
  rememberedChoice(): string {
    return this.remembered;
  }

  private remembered = "";

  /** The transcript, joined and rendered — everything `open` does with what it
   *  fetched, and nothing that does the fetching.
   *
   *  Split out so a caller that already HAS the bytes can produce exactly the
   *  same messages: the conversation page's loader reads them on the server,
   *  as the person asking, so the first paint has the conversation in it
   *  rather than an empty pane a round trip wide. There is deliberately only
   *  one copy of this join — a second one in a loader would drift, and the
   *  drift shows up as a conversation claiming work it does not display. */
  apply(
    turns: TranscriptTurn[],
    past: Pick<RoundSteps, "steps" | "thoughts">,
    /* The by-turn join, because the transcript's own refs arrive empty from
       the engine while the join is filled — verified against a live save:
       turn refs [], by-turn carrying the row. A card is drawn from whichever
       source has it. Optional so the SSR loader, which fetches two things,
       keeps working; the client re-applies with all three. */
    byTurn: TurnArtifactRef[] = [],
  ): void {

    // A round's rows carry the seq of the turn that *opened* it — the question —
    // while the answer is stored further along, past the tool turns the reader
    // never sees. So the two are not joined on equal seqs: a round belongs to
    // the first answer that comes after it, which is true whatever sits in
    // between and stays true when a round leaves no visible answer at all —
    // its card lands on the next one rather than vanishing.
    const rounds = new Map<number, { steps: LiveStep[]; thoughts: Thought[] }>();
    const round = (seq: number) => {
      const had = rounds.get(seq) ?? { steps: [], thoughts: [] };
      rounds.set(seq, had);
      return had;
    };
    for (const s of past.steps) round(s.seq).steps.push(s);
    for (const t of past.thoughts) round(t.seq).thoughts.push(t);
    const pending = [...rounds.keys()].sort((a, b) => a - b);
    const refsPending = [...byTurn].sort((a, b) => a.turnSeq - b.turnSeq);
    this.doneSeq = pending.length > 0 ? pending[pending.length - 1] : -1;
    this.renderedSeq = turns.length > 0 ? Math.max(...turns.map((t) => t.seq)) : -1;

    this.setMessages(turns.map((t, i) => {
      let card = "";
      if (t.role !== "user") {
        const mine: number[] = [];
        while (pending.length > 0 && pending[0] < t.seq) mine.push(pending.shift()!);
        const steps = mine.flatMap((s) => rounds.get(s)!.steps);
        const thoughts = mine.flatMap((s) => rounds.get(s)!.thoughts);
        card = stepsCard(steps, thoughts);
      }
      let saved: WireRef[] = t.refs ?? [];
      if (t.role !== "user" && saved.length === 0) {
        const mine: WireRef[] = [];
        while (refsPending.length > 0 && refsPending[0].turnSeq < t.seq) {
          const r = refsPending.shift() as TurnArtifactRef;
          mine.push({ slot: r.slot, version: r.version, path: r.path });
        }
        saved = mine;
      }
      return {
        id: `t${i}`,
        sender: t.role === "user" ? "user" : "bot" as const,
        text: t.role === "user" ? escapeHtml(t.text)
          : card + renderWithCards(t.text, (s) => renderMarkdown(escapeHtml(s))) + refCards(saved),
        refs: t.refs,
        timestamp: new Date().toISOString(),
      };
    }));
  }

  /** Start a fresh conversation. Nothing is stored until something is said. */
  fresh(): void {
    this.stopFollowing();
    this.threadId = "";
    // A conversation that does not exist has remembered nothing. The
    // composer's picker is NOT reset with it — that is the console's, and
    // what it shows is what the next send will carry, whichever conversation
    // that send opens.
    this.remembered = "";
    // Nothing to watch on the home screen, and saying so stops the server
    // polling a conversation nobody has open.
    live.watch("");
    this.doneSeq = -1;
    this.setMessages([]);
  }

  currentThreadId(): string {
    return this.threadId;
  }

  isTyping(): boolean {
    return this.state.isTyping;
  }

  // --- internals ------------------------------------------------------------

  // Redraw the card inside the in-flight turn. A new array each time, because
  // the component compares state objects to decide whether to render.
  private paintLive(): void {
    if (this.liveId === "") return;
    const card = stepsCard(this.live, this.thoughts);
    this.setMessages(this.state.messages.map((m) =>
      m.id === this.liveId ? { ...m, text: card } : m));
  }

  // The answer takes the placeholder's place rather than being appended after
  // it, so a round leaves exactly one bot turn behind.
  private replaceLive(m: Omit<ChatMessage, "timestamp">, liveId: string): void {
    const at = this.state.messages.findIndex((x) => x.id === liveId);
    const full = { ...m, timestamp: new Date().toISOString() };
    if (at < 0) { this.push(m); return; }
    const next = [...this.state.messages];
    next[at] = full;
    this.setMessages(next);
  }

  private push(m: Omit<ChatMessage, "timestamp">): void {
    this.setMessages([...this.state.messages, { ...m, timestamp: new Date().toISOString() }]);
  }

  private setMessages(messages: ChatMessage[]): void {
    this.state = { ...this.state, messages };
    this.emit("state:changed", this.state);
  }

  private setTyping(on: boolean): void {
    if (this.state.isTyping === on) return;
    this.state = { ...this.state, isTyping: on, isProcessing: on };
    this.emit("state:changed", this.state);
    this.emit(on ? "typing:start" : "typing:end", {});
  }

  private emit(event: string, payload: unknown): void {
    // A listener that throws must not stop the others, and must not leave the
    // typing indicator stuck on because the failure happened mid-broadcast.
    for (const fn of this.listeners.get(event) ?? []) {
      try { fn(payload); } catch { /* one bad listener is not the session's problem */ }
    }
  }
}

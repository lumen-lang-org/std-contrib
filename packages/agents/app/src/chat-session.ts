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

import { LiveStep, RoundSteps, Thought, WireRef, openThread, say, threadSteps, transcript } from "./api.js";

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
const CARD = "border:1px solid rgba(0,0,0,.12);border-radius:10px;margin:0 0 10px;"
  + "overflow:hidden;font-size:13px;min-width:min(560px,72vw)";
const HEAD = "display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:500";
const ROW = "display:flex;gap:8px;padding:6px 12px;align-items:baseline";
const NAME = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace";
const ARGS = "flex:1;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace";
const MS = "opacity:.55;font-variant-numeric:tabular-nums";

const THINK = "padding:6px 12px;border-top:1px solid rgba(0,0,0,.06)";
const THINK_TEXT = "margin:.4rem 0 .2rem;white-space:pre-wrap;opacity:.7;font-size:12.5px";
const DIFF = "margin:.35rem 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;"
  + "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:16rem;overflow:auto";

// The fields an edit step stores, or null when the row is not that shape —
// an old round's row, or a fallback prefix — in which case the raw preview is
// shown as it always was.
function editFields(args: string): { path: string; added: number; removed: number; old: string; new: string; cut: boolean } | null {
  try {
    const p = JSON.parse(args) as Record<string, unknown>;
    if (typeof p.path !== "string" || typeof p.old !== "string" || typeof p.new !== "string") return null;
    return {
      path: p.path, old: p.old, new: p.new,
      added: typeof p.added === "number" ? p.added : 0,
      removed: typeof p.removed === "number" ? p.removed : 0,
      cut: p.cut === true,
    };
  } catch { return null; }
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
      const mark = s.running ? "&#8230;" : (s.ok ? "&#10003;" : "&#10007;");
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
          + `<pre style="${DIFF};background:rgba(179,56,46,.08)">${escapeHtml(edit.old)}</pre>`
          + `<pre style="${DIFF};background:rgba(47,138,76,.08)">${escapeHtml(edit.new)}</pre>`
          + (edit.cut ? `<div style="opacity:.55;font-size:11.5px">cut — the whole text is in the artifact's history</div>` : "")
          + `</div></details>`;
        continue;
      }
      const detail = s.kind === "agent" ? s.target : s.args;
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
  onThreadOpened: (threadId: string) => void;
  onTurnDone: () => void;
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
  // is already on screen for it.
  private pending: { id: string; said: string }[] = [];
  private live: LiveStep[] = [];
  private thoughts: Thought[] = [];
  private polling = 0;
  // The placeholder turn the card is drawn into while the round runs.
  private liveId = "";

  private state: {
    messages: ChatMessage[];
    threads: never[];
    suggestions: never[];
    isProcessing: boolean;
    isTyping: boolean;
  } = {
    messages: [],
    threads: EMPTY,
    suggestions: EMPTY,
    isProcessing: false,
    isTyping: false,
  };

  constructor(private readonly bridge: SessionBridge) {}

  // --- the contract nr-chatbot uses -----------------------------------------

  on(event: string, fn: Listener): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(event, set);
    return () => { set.delete(fn); };
  }

  getState() {
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
  private watch(): void {
    if (this.polling !== 0 || this.threadId === "") return;
    this.polling = window.setInterval(async () => {
      try {
        const round = await threadSteps(this.threadId);
        this.live = round.steps;
        this.thoughts = round.thoughts ?? [];
        this.paintLive();
        this.emit("steps:changed", round);
      } catch { /* the answer is still coming; the next tick asks again */ }
    }, 400);
  }

  private unwatch(): void {
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
    const said = text.trim();
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
    this.pending.push({ id, said });
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
      await this.turn(next.said);
    }
  }

  private async turn(said: string): Promise<void> {
    this.setTyping(true);

    try {
      if (this.threadId === "") {
        this.threadId = (await openThread(this.bridge.agentId())).id;
        this.bridge.onThreadOpened(this.threadId);
      }
      // A placeholder turn to hang the card on. The answer has not arrived, so
      // this is what the card attaches to while the calls are running; the
      // answer replaces its text when it lands.
      const liveId = `live-${this.state.messages.length}`;
      this.liveId = liveId;
      this.push({ id: liveId, sender: "bot", text: "", refs: EMPTY });

      this.watch();
      const reply = await say(this.threadId, said);
      // The answer carries its own calls, so the card settles on what the
      // server recorded rather than on whatever the last poll tick caught.
      this.unwatch();
      this.live = reply.steps ?? [];
      this.thoughts = reply.thoughts ?? [];
      this.emit("steps:changed", { seq: reply.seq, running: false, steps: this.live });
      this.liveId = "";
      // A refusal is an answer. The API says why in a sentence — no credential,
      // no such agent, a model it cannot reach — and that sentence belongs in
      // the transcript, where it can be read, rather than in an error toast.
      // The card and the answer are one message, so they cannot drift apart or
      // be read as belonging to different turns.
      this.replaceLive({
        id: reply.runId,
        sender: "bot",
        text: stepsCard(this.live, this.thoughts) + escapeHtml(reply.ok ? reply.text : reply.error),
        refs: reply.refs,
        error: !reply.ok,
      }, liveId);
      this.emit("message:received", { ok: reply.ok });
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

  // No upload path here yet: files go through the workspace panel and its own
  // routes. Present because the component calls it unconditionally after a
  // send.
  clearFiles(): void {}

  // --- what the console drives ----------------------------------------------

  /** Open an existing conversation and show its turns. */
  async open(threadId: string): Promise<void> {
    this.threadId = threadId;
    // The turns and every round's calls and reasoning, together. A card is not
    // a live-only ornament: it is what the answer above it was made of, and a
    // reload that dropped it left the conversation claiming work it no longer
    // showed. Asked in parallel — the transcript does not depend on the steps.
    const [turns, past] = await Promise.all([
      transcript(threadId),
      threadSteps(threadId, "all").catch(() => ({ steps: [], thoughts: [] } as Pick<RoundSteps, "steps" | "thoughts">)),
    ]);

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

    this.setMessages(turns.map((t, i) => {
      let card = "";
      if (t.role !== "user") {
        const mine: number[] = [];
        while (pending.length > 0 && pending[0] < t.seq) mine.push(pending.shift()!);
        const steps = mine.flatMap((s) => rounds.get(s)!.steps);
        const thoughts = mine.flatMap((s) => rounds.get(s)!.thoughts);
        card = stepsCard(steps, thoughts);
      }
      return {
        id: `t${i}`,
        sender: t.role === "user" ? "user" : "bot" as const,
        text: card + escapeHtml(t.text),
        refs: t.refs,
        timestamp: new Date().toISOString(),
      };
    }));
  }

  /** Start a fresh conversation. Nothing is stored until something is said. */
  fresh(): void {
    this.threadId = "";
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

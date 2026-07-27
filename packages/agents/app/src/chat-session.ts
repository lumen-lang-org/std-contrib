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

import { WireRef, openThread, say, transcript } from "./api.js";

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

  async sendMessage(text: string): Promise<void> {
    const said = text.trim();
    if (said === "" || this.state.isTyping) return;

    // The raw text goes to the API; the escaped copy goes on screen. A user
    // pasting an HTML snippet to ask about it must see the snippet, not run it.
    this.push({
      id: `u${this.state.messages.length}`, sender: "user",
      text: escapeHtml(said), refs: EMPTY,
    });
    this.emit("message:sent", { text: said });
    this.setTyping(true);

    try {
      if (this.threadId === "") {
        this.threadId = (await openThread(this.bridge.agentId())).id;
        this.bridge.onThreadOpened(this.threadId);
      }
      const reply = await say(this.threadId, said);
      // A refusal is an answer. The API says why in a sentence — no credential,
      // no such agent, a model it cannot reach — and that sentence belongs in
      // the transcript, where it can be read, rather than in an error toast.
      this.push({
        id: reply.runId,
        sender: "bot",
        text: escapeHtml(reply.ok ? reply.text : reply.error),
        refs: reply.refs,
        error: !reply.ok,
      });
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
    const turns = await transcript(threadId);
    this.setMessages(turns.map((t, i) => ({
      id: `t${i}`,
      sender: t.role === "user" ? "user" : "bot" as const,
      text: escapeHtml(t.text),
      refs: t.refs,
      timestamp: new Date().toISOString(),
    })));
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

// Tasks: conversations that happen without you.
//
// A page and not an overlay, which is a claim about what a task is. An overlay
// is for something you check and dismiss; a task is something you keep — you
// come back to it, reword it, look at what it said last time. That wants an
// address you can link to, a back button that works, and room for three
// things at once: what is scheduled, what one of them says, and what it
// answered when it last ran.
//
// The schedule is typed in words — "every weekday at 08:00" — and compiled by
// the engine, which owns the grammar and the timezone database. Nothing here
// parses a schedule or computes a firing time. That is deliberate: a client
// that guessed at either would disagree with the runner exactly twice a year,
// on the mornings the clocks move, and would be believed, because it is the
// thing on screen.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./ui.js";
import {
  AgentRow, RunDocument, TaskRow, listAgents, runDocument,
  listTasks, createTask, changeTask, runTaskNow, deleteTask } from "./api.js";

// The words the engine accepts, offered where somebody is about to type. Not
// validation — the engine refuses what it cannot read and says why — but the
// difference between a person's first attempt working and their third.
const EXAMPLES = [
  "every weekday at 08:00",
  "every day at 07:30",
  "every monday at 09:15",
  "every 30 minutes",
  "every 6 hours",
];

type Draft = {
  id: string;
  title: string;
  instruction: string;
  schedule: string;
  enabled: boolean;
};

// The empty draft, so "new task" and "stop editing this one" are one act.
const BLANK: Draft = { id: "", title: "", instruction: "", schedule: "", enabled: true };

@customElement("console-tasks")
export class ConsoleTasks extends LitElement {
  static styles = css`
    /* flex + min-height:0, matching artifact-library and knowledge-page. The
       first version said display:block with height:100% and drew a box zero
       pixels tall: this element is a flex item in the console's own column, so
       a percentage height resolves against a parent that has not sized itself
       yet. The page rendered — one child in the shadow root — and could not be
       seen, which reads as "nothing happened" rather than as a layout bug. */
    :host { display: flex; height: 100%; min-height: 0; min-width: 0;
            overflow: hidden; background: var(--bg); color: var(--fg); }

    .page { flex: 1; min-width: 0; display: grid;
            grid-template-columns: minmax(280px, 340px) 1fr; }
    /* One column under a tablet width, list first — it is what you came for.
       The editor follows it down the page rather than hiding behind a tab,
       which would put "add a task" two taps away on the screen where it is
       most often done. */
    @media (max-width: 900px) {
      .page { grid-template-columns: 1fr; grid-template-rows: auto 1fr;
              overflow-y: auto; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
    }

    aside { border-right: 1px solid var(--line); overflow-y: auto;
            padding: 22px 16px 28px; display: flex; flex-direction: column; gap: 14px; }
    main { overflow-y: auto; padding: 24px 28px 40px;
           display: flex; flex-direction: column; gap: 20px; }

    h1 { margin: 0; font: 700 22px/1.25 var(--display); letter-spacing: -.01em; }
    h2 { margin: 0; font: 600 15px/1.3 var(--display); }
    .lede { margin: 0; color: var(--muted); font-size: 13px; max-width: 62ch; }

    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .count { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

    .rows { display: flex; flex-direction: column; gap: 6px; }

    /* One task. The whole row is the target — a list where only the words can
       be clicked teaches people to aim. */
    .task { text-align: left; width: 100%; display: grid; gap: 3px;
            padding: 11px 12px; border-radius: 10px; cursor: pointer;
            border: 1px solid transparent; background: none; color: inherit; font: inherit;
            transition: background-color .15s cubic-bezier(.23,1,.32,1),
                        border-color .15s cubic-bezier(.23,1,.32,1); }
    .task:hover { background: var(--bg-sunken); }
    .task[aria-current="true"] { background: var(--bg-sunken); border-color: var(--line); }
    .task[data-off] .name { color: var(--muted); }
    .name { font: 600 13.5px/1.35 var(--display); overflow-wrap: anywhere; }
    .when { color: var(--muted); font-size: 12px;
            display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
    .flag { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
    .flag.bad { color: var(--bad, #b3261e); }
    .flag.off { color: var(--muted); }

    .empty { padding: 22px 14px; color: var(--muted); font-size: 13px;
             border: 1px dashed var(--line); border-radius: 10px; text-align: center; }

    /* The editor. The same shape whether it holds a new task or an existing
       one, because they are the same act; only which buttons are worth showing
       differs. */
    form { display: flex; flex-direction: column; gap: 14px; max-width: 760px; }
    label { display: flex; flex-direction: column; gap: 5px;
            font-size: 12.5px; color: var(--muted); }
    .two { display: flex; gap: 12px; flex-wrap: wrap; }
    .two > label { flex: 1 1 240px; }
    .hints { display: flex; flex-wrap: wrap; gap: 6px; }
    .hints button { border: 1px solid var(--line); background: var(--bg-raised);
                    color: var(--muted); border-radius: 999px; padding: 4px 10px;
                    font: inherit; font-size: 12px; cursor: pointer;
                    transition: color .15s cubic-bezier(.23,1,.32,1),
                                border-color .15s cubic-bezier(.23,1,.32,1); }
    .hints button:hover { color: var(--fg); border-color: var(--fg); }
    .acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .zone { color: var(--muted); font-size: 12.5px; }
    .danger { color: var(--bad, #b3261e); }

    /* The preview: what it said last time. Bordered and quiet — evidence, not
       the point of the screen. */
    .preview { border: 1px solid var(--line); border-radius: 12px;
               background: var(--bg-raised); padding: 16px 18px;
               display: flex; flex-direction: column; gap: 10px; max-width: 760px; }
    .meta { color: var(--muted); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
    .said { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
            font-size: 13.5px; line-height: 1.55; max-height: 320px; overflow-y: auto; }
    .said.none { color: var(--muted); }
    .open { align-self: flex-start; color: var(--fg); font-size: 13px; }

    .err { margin: 0; color: var(--bad, #b3261e); font-size: 13px; }

    @media (prefers-reduced-motion: reduce) {
      .task, .hints button { transition-duration: .01ms; }
    }
  `;

  /** Prefilled instruction — what the composer held when somebody chose
   *  "Schedule this". "" for an ordinary arrival. */
  @property({ type: String }) draft = "";

  @state() private tasks: TaskRow[] = [];
  @state() private agents: AgentRow[] = [];
  @state() private chosen = "";
  @state() private editing: Draft = { ...BLANK };
  @state() private ran: RunDocument | null = null;
  @state() private problem = "";
  @state() private busy = "";
  /* Whether the caller can schedule at all. A guest may read this page — the
     list answers, empty — and may not create anything, which the engine
     enforces. Knowing it here is what turns a red error under a form into a
     sentence above one, which is the difference between "something went
     wrong" and "this is not yours yet". */
  @state() private mayCreate = true;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.draft !== "") { this.editing = { ...BLANK, instruction: this.draft }; }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      // Separately, and not with Promise.all: /agents answers 401 to a guest
      // by design, and one rejection would throw away the task list that had
      // answered perfectly well beside it.
      this.tasks = await listTasks().catch(() => []);
      const agents = await listAgents().catch(() => null);
      this.mayCreate = agents !== null && agents.length > 0;
      this.agents = agents ?? [];
      // A chosen task that has just been deleted stops being chosen, rather
      // than leaving the editor holding a row nobody can save.
      if (this.chosen !== "" && !this.tasks.some((t) => t.id === this.chosen)) { this.clear(); }
    } catch (e) {
      this.problem = e instanceof Error ? e.message : String(e);
    }
  }

  /* The zone, as the browser knows it. Sent on create so the engine schedules
     in the person's own day rather than the server's — the two agree only by
     luck, and the luck runs out at 02:00 twice a year. */
  private zone(): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"; }
    catch { return "UTC"; }
  }

  /* A stamp as the person's own clock reads it. The engine sends epoch
     milliseconds as text — the one honest wire format for an instant — and
     turning that into "Thu 08:00" is the client's job, because only the client
     knows what "today" means to whoever is looking. */
  private clock(ms: string): string {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const at = new Date(n);
    const near = Math.abs(at.getTime() - Date.now()) < 6 * 24 * 3600 * 1000;
    return at.toLocaleString(undefined, near
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  private clear(): void {
    this.chosen = "";
    this.editing = { ...BLANK };
    this.ran = null;
  }

  private async choose(t: TaskRow): Promise<void> {
    this.chosen = t.id;
    this.problem = "";
    this.editing = {
      id: t.id, title: t.title, instruction: t.instruction,
      // Deliberately blank rather than the stored cron expression. Cron is
      // what the engine keeps, not what anybody typed, and printing
      // "0 0 8 * * 1-5" into a box a person is invited to edit would teach
      // them a language this product does not speak. Empty means "leave the
      // schedule alone", and the placeholder says when it next runs.
      schedule: "", enabled: t.enabled,
    };
    await this.loadRun(t);
  }

  /* What it said last time. One call: the run document carries the answer and
     the conversation it happened in, so the preview and the link under it
     cannot disagree. */
  private async loadRun(t: TaskRow): Promise<void> {
    this.ran = null;
    if (t.lastRunId === "") { return; }
    try { this.ran = await runDocument(t.lastRunId); }
    catch {
      // A preview that cannot be fetched is a quiet absence, not an error
      // banner over a page that is otherwise working.
      this.ran = null;
    }
  }

  private async act(id: string, what: () => Promise<unknown>): Promise<void> {
    this.busy = id;
    this.problem = "";
    try { await what(); await this.refresh(); }
    catch (e) { this.problem = e instanceof Error ? e.message : String(e); }
    finally { this.busy = ""; }
  }

  private async save(e: Event): Promise<void> {
    e.preventDefault();
    this.problem = "";
    const d = this.editing;
    if (d.instruction.trim() === "") { this.problem = "A task needs something to do."; return; }
    if (d.id === "" && d.schedule.trim() === "") {
      this.problem = "A task needs a schedule — try “every weekday at 08:00”.";
      return;
    }
    this.busy = "save";
    try {
      if (d.id === "") {
        const made = await createTask({
          agentId: (this.agents.find((a) => a.isDefault) ?? this.agents[0])?.id ?? "",
          title: d.title.trim(), instruction: d.instruction.trim(),
          schedule: d.schedule.trim(), tz: this.zone(),
        });
        await this.refresh();
        const fresh = this.tasks.find((x) => x.id === made.id);
        if (fresh !== undefined) { await this.choose(fresh); }
      } else {
        // Only what changed. A field the engine is not sent is a field it
        // keeps, which is what lets the schedule box stay empty for "as it is".
        await changeTask(d.id, {
          title: d.title.trim(), instruction: d.instruction.trim(), enabled: d.enabled,
          ...(d.schedule.trim() === "" ? {} : { schedule: d.schedule.trim(), tz: this.zone() }),
        });
        await this.refresh();
      }
    } catch (err) {
      // The engine's own sentence, shown as it wrote it. Every refusal it
      // sends is already something a person can act on — "the shortest
      // interval is 15 minutes" — and rewording them here would mean two
      // vocabularies for one rule.
      this.problem = err instanceof Error ? err.message : String(err);
    } finally { this.busy = ""; }
  }

  private edit(part: Partial<Draft>): void {
    this.editing = { ...this.editing, ...part };
  }

  private renderRow(t: TaskRow) {
    return html`
      <button class="task" ?data-off=${!t.enabled}
        aria-current=${this.chosen === t.id ? "true" : "false"}
        @click=${() => this.choose(t)}>
        <span class="name">${t.title === "" ? t.instruction : t.title}</span>
        <span class="when">
          ${t.enabled
            ? html`<span>Next ${this.clock(t.nextAt)}</span>`
            : html`<span class="flag off">Paused</span>`}
          ${t.runCount > 0 ? html`<span>· ran ${t.runCount}×</span>` : nothing}
          ${t.lastStatus === "failed" ? html`<span class="flag bad">failed</span>` : nothing}
        </span>
      </button>`;
  }

  private renderPreview(t: TaskRow) {
    return html`
      <section class="preview">
        <h2>Last run</h2>
        <div class="meta">
          ${t.runCount === 0
            ? html`<span>It has not run yet.</span>`
            : html`
                <span>${this.clock(t.lastRunAt)}</span>
                <span>· ${t.runCount} run${t.runCount === 1 ? "" : "s"}</span>
                ${t.lastStatus === "failed"
                  ? html`<span class="danger">· failed</span>` : nothing}`}
        </div>
        ${t.lastError === "" ? nothing : html`<p class="err">${t.lastError}</p>`}
        ${t.runCount === 0 ? nothing : (this.ran === null || this.ran.answer === ""
          ? html`<p class="said none">No answer was stored for that run.</p>`
          : html`
              <p class="said">${this.ran.answer}</p>
              <!-- A link and not a button: this is a place, and people
                   middle-click places. -->
              <a class="open" href=${`/c/${encodeURIComponent(this.ran.threadId)}`}
                >Open the conversation</a>`)}
      </section>`;
  }

  render() {
    const existing = this.editing.id !== "";
    const t = this.tasks.find((x) => x.id === this.chosen);
    return html`
      <div class="page">
        <aside>
          <div class="head">
            <h1>Tasks</h1>
            <span class="count">${this.tasks.length}</span>
          </div>
          <p class="lede">Work that runs without you. Each run opens a
            conversation of its own.</p>
          <nr-button @click=${() => this.clear()}>New task</nr-button>
          <div class="rows">
            ${this.tasks.length === 0
              ? html`<div class="empty">Nothing scheduled yet.</div>`
              : this.tasks.map((x) => this.renderRow(x))}
          </div>
        </aside>

        <main>
          <h2>${existing ? "Edit task" : "New task"}</h2>
          ${this.mayCreate ? nothing : html`
            <p class="lede">Scheduling is for people with an account — a task
              runs on your connectors, on your schedule, so it has to belong to
              somebody. <a href="/auth/login">Sign in</a> and this page is
              yours.</p>`}
          <form @submit=${(e: Event) => this.save(e)}>
            <label>What should happen
              <nr-textarea rows="3" .value=${this.editing.instruction}
                placeholder="Summarise what changed in my Linear cycle"
                @input=${(e: Event) => this.edit({ instruction: (e.target as HTMLInputElement).value })}
              ></nr-textarea>
            </label>
            <div class="two">
              <label>When
                <nr-input .value=${this.editing.schedule}
                  placeholder=${existing && t !== undefined
                    ? `Next ${this.clock(t.nextAt)} — type to change it`
                    : "every weekday at 08:00"}
                  @input=${(e: Event) => this.edit({ schedule: (e.target as HTMLInputElement).value })}
                ></nr-input>
              </label>
              <label>Called
                <nr-input .value=${this.editing.title} placeholder="Morning check"
                  @input=${(e: Event) => this.edit({ title: (e.target as HTMLInputElement).value })}
                ></nr-input>
              </label>
            </div>
            <div class="hints">
              ${EXAMPLES.map((x) => html`
                <button type="button" @click=${() => this.edit({ schedule: x })}>${x}</button>`)}
            </div>
            <div class="acts">
              <nr-button type="submit" ?disabled=${this.busy === "save" || !this.mayCreate}>
                ${this.busy === "save" ? "Saving…" : existing ? "Save changes" : "Schedule it"}
              </nr-button>
              ${!existing || t === undefined ? nothing : html`
                <nr-button type="button" ?disabled=${this.busy === t.id}
                  @click=${() => this.act(t.id, () => runTaskNow(t.id))}>Run soon</nr-button>
                <nr-button type="button" ?disabled=${this.busy === t.id}
                  @click=${() => this.act(t.id, () => changeTask(t.id, { enabled: !t.enabled }))}
                  >${t.enabled ? "Pause" : "Resume"}</nr-button>
                <nr-button type="button" class="danger" ?disabled=${this.busy === t.id}
                  @click=${() => this.act(t.id, () => deleteTask(t.id))}>Delete</nr-button>`}
              <span class="zone">Times are read in ${this.zone()}.</span>
            </div>
          </form>

          ${this.problem === "" ? nothing : html`<p class="err" role="alert">${this.problem}</p>`}
          ${t === undefined ? nothing : this.renderPreview(t)}
        </main>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { "console-tasks": ConsoleTasks; }
}

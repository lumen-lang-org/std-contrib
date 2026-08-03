// The model choice, in the composer.
//
// One control: the label of what the next message will run on, a chevron, and
// a menu of the operator's curated rows (MODEL-CHOICE.md, "What the user
// sees"). The composer and not the header, because the header's agent chip is
// `display: none` below 640px and a choice that vanishes on a phone is not a
// choice; the composer survives every breakpoint.
//
// It fires `pick-choice` and does nothing else. The selection travels WITH THE
// MESSAGE — it rides the messages POST as `modelChoiceId` — so changing it
// must never reach the network on its own. There is deliberately no fetch, no
// PUT and no thread id anywhere in this file: this element renders a list it
// is handed and announces what was clicked.
//
// --- where this element actually lives, and why it is not where lit put it ---
//
// nr-chatbot lays out its action row as left group | right group, with the
// send button in the right group and `min-width: calc(40px + 0.5rem)` holding
// 48px of space for it. That reserved space is the "empty slot" the design
// note measured at 48x0: it is 0 high only because the send button renders
// solely when there is text to send (input-box.template.js, `renderSendButton`
// behind `data.currentInput.trim() || ...`). So the slot is not empty by
// design — it is the send button's, and it fills the moment you type.
//
// Two ways in were considered before this one:
//
//   1. Give the component content there through its properties. It cannot be
//      done. The input box's shadow DOM carries no slot at all (the four
//      `<slot>`s in this component are messages, header, footer and
//      empty-state — none of them inside the composer), and the only
//      content-bearing property anywhere near the action row is
//      `enableModuleSelection`/`modules`, which is a MULTI-select rendered in
//      the LEFT group with its own change event and its own notion of what a
//      module is. Dressing a model picker as a multi-select of modules would
//      be a lie in the DOM and would still be on the wrong side of the row.
//
//   2. Render it in the console's own DOM, absolutely positioned over that
//      slot from a measured rect. Rejected on the measurement above: the slot
//      is where the send button appears, so an overlay parked on it covers the
//      send button as soon as there is anything to send. It would also have to
//      be re-measured on every resize, on the empty-state-to-conversation
//      relayout, and on every scroll — three chances to be one frame wrong,
//      for a control that must sit still.
//
// So the element is created, owned, rendered and updated by agent-console —
// it is a static node in that element's template and every binding on it is
// lit's — and the console then MOVES the host node into the component's action
// row, ahead of the send button, so it sits in the composer's own flex flow.
// It costs nothing to lay out, it cannot drift, and it is the position the
// design note draws. The two consequences of that move are handled here:
//
//   - agent-console's stylesheet no longer reaches it, so everything this
//     element looks like is in its own `static styles` below. The palette
//     still arrives: the tokens are `:root` custom properties in head.html and
//     custom properties inherit across shadow boundaries, which is the same
//     mechanism CHAT_SKIN in console.ts already relies on.
//   - it is hidden until the move has happened. The console is
//     server-rendered, and on the server the node is still sitting where lit
//     put it; without this rule the picker would paint once in the wrong place
//     and then jump. `docked` is a bare attribute the console stamps rather
//     than a reactive property, because nothing must ever take it off again.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ModelChoice } from "./api.js";

@customElement("model-picker")
export class ModelPicker extends LitElement {
  static styles = css`
    :host { position: relative; display: inline-flex; align-items: center; }
    :host(:not([docked])) { display: none; }

    /* The same reading as the header icons: no border, ink rather than grey,
       and hover as a wash. An outlined control here would be the only box in
       the composer's action row and would read as a second send button. */
    .trigger { display: inline-flex; align-items: center; gap: 3px;
               background: none; border: 0; border-radius: 999px;
               padding: 5px 7px 5px 10px; cursor: pointer; font: inherit;
               font-size: 13px; color: var(--muted); white-space: nowrap;
               max-width: 40vw; overflow: hidden;
               transition: background-color .15s cubic-bezier(.23,1,.32,1),
                           color .15s cubic-bezier(.23,1,.32,1); }
    .trigger:hover,
    .trigger[aria-expanded="true"] { background: var(--bg-sunken); color: var(--fg); }
    .trigger span { overflow: hidden; text-overflow: ellipsis; }

    /* On a phone the name goes and the chevron stays.
       Two reasons, and the first is a real bug rather than a preference: the
       composer's right-hand group is justify-content: flex-end and cannot
       shrink, so anything too wide for it spills LEFTWARD, out of its own box
       and straight over the Search chip — "SearchDefault" in one line of
       overlapping text. It is worst mid-run, when the send button becomes
       "Stop" and takes the room with it.
       The second is that the name is the least urgent thing in the row: which
       model answers is a setting, the chevron still says it is changeable, and
       one tap shows the name in the menu. 40vw of a 390px screen spent on
       "Qwen 3 8B (local vLL…" is 40vw spent on a truncation. */
    /* One label or the other, never both. */
    .trigger .short { display: none; }
    @media (max-width: 640px) {
      .trigger .long { display: none; }
      .trigger .short { display: inline; }
      /* Bounded, so it can never be the thing that overflows the row again:
         the group it sits in cannot shrink, so anything too wide paints over
         the chips to its left rather than clipping. */
      .trigger { padding: 5px 6px 5px 8px; max-width: 33vw; }
    }

    /* Upwards, because the composer sits at the bottom of the window and a
       menu below it would open off the screen. It escapes the composer because
       .input-container is overflow:visible and position:relative — the same
       thing the attach button's own menu already does from inside there. The
       z-index clears that menu's 100. */
    /* The panel — position, animation, outside-click, Escape — is
       nr-dropdown's now; this element was the product's last hand-rolled
       floating menu, and on a phone its home-grown positioning is exactly what
       misbehaved. What remains here is what the CONTENT owns: width and inner
       padding. The panel's own look rides the dropdown's tokens, set on the
       host tag so they cross its shadow boundary. */
    nr-dropdown {
      --nuraly-dropdown-max-height: min(44vh, 330px);
      --nuraly-dropdown-background: var(--bg-card);
      --nuraly-dropdown-border-color: var(--border);
      --nuraly-dropdown-border-radius: 12px;
    }
    .menu { width: 296px; max-width: 78vw; padding: 4px; box-sizing: border-box;
            overscroll-behavior: contain; }

    .row { display: flex; align-items: flex-start; gap: 8px; width: 100%;
           box-sizing: border-box; padding: 8px 10px; border: 0;
           border-radius: 8px; background: none; font: inherit; color: var(--fg);
           text-align: left; cursor: pointer;
           transition: background-color .15s cubic-bezier(.23,1,.32,1); }
    .row:hover { background: var(--bg-sunken); }
    .body { flex: 1; min-width: 0; }
    .name { display: flex; align-items: center; gap: 6px; font-size: 13.5px;
            font-weight: 500; }
    .why { font-size: 12px; color: var(--muted); line-height: 1.35; }
    /* Reserved whether or not there is a check in it, so the labels of the
       chosen row and every other row start at the same x. */
    .mark { flex: none; width: 16px; display: grid; place-items: center;
            padding-top: 1px; }
    .tier { color: var(--muted); }
    .soon-head { font-size: 11px; font-weight: 600; letter-spacing: .05em;
                 text-transform: uppercase; color: var(--faint, var(--muted));
                 padding: 6px 10px 2px; }
    .row.soon { cursor: default; opacity: .55; }
    .row.soon:hover { background: none; }
    hr { border: 0; border-top: 1px solid var(--border); margin: 4px 6px; }

    :focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  `;

  /** The menu, in the operator's rank order — GET /models/choices, exactly as
   *  it arrived. Not filtered and not sorted here: the engine answers only
   *  enabled rows and answers them in order, and a second opinion about either
   *  is a second thing to keep true. */
  @property({ attribute: false }) choices: ModelChoice[] = [];

  /** What the next message will carry. "" is the agent's own model, which is
   *  what every conversation written before this feature means. */
  @property() choiceId = "";

  /** The model behind the agent's own config, for the last line of the menu.
   *  "" when the console could not name it — the line then reads "Agent
   *  default" alone rather than "Agent default ()". */
  @property() defaultLabel = "";

  /* Open/close, outside-click and Escape all belong to nr-dropdown now. The
     document listeners that lived here — with their reparent-symmetry
     choreography — were the cost of hand-rolling the one floating menu in the
     product that was not an nr-dropdown, and they left with it. */

  /** The trigger's word. The chosen row's label, or the agent's own model when
   *  nothing is chosen — the control says what will answer, never "none". */
  /* The rows a person can actually pick, and the priced shelf under them. */
  private offered(): ModelChoice[] {
    return this.choices.filter((c) => c.tier !== "premium");
  }

  private premium(): ModelChoice[] {
    return this.choices.filter((c) => c.tier === "premium");
  }

  private showing(): string {
    const chosen = this.choices.find((c) => c.id === this.choiceId);
    if (chosen !== undefined) { return chosen.label; }
    return this.defaultLabel === "" ? "Default" : this.defaultLabel;
  }

  /** The same answer, short enough for a phone.
   *
   *  Which model is answering has to stay READABLE — a lone chevron says
   *  something is changeable without saying what it is set to, which is the
   *  one thing this control exists to say. But the full label does not fit:
   *  "Qwen 3 8B (local vLLM)" in a strip that also holds two chips and a send
   *  button is a truncation at best, and at worst it overflows its own group
   *  and paints across the chips.
   *
   *  So the label is cut at its first bracket or dash — the parenthetical is
   *  where a label keeps its deployment detail ("(local vLLM)", "— fast"),
   *  and the head is the name a person actually chose. "Auto" and "Default"
   *  are already short and come through untouched. */
  private showingShort(): string {
    const full = this.showing();
    const head = full.split(/[(\u2014-]/)[0].trim();
    const short = head === "" ? full : head;
    return short.length > 14 ? short.slice(0, 13).trimEnd() + "\u2026" : short;
  }

  /** Concatenated rather than interpolated: a nested template literal inside
   *  an html`` literal is legal and is also exactly the shape that has ended
   *  the outer literal by accident four times in this app. */
  private defaultRow(): string {
    return this.defaultLabel === "" ? "Agent default" : "Agent default (" + this.defaultLabel + ")";
  }

  private pick(id: string): void {
    (this.renderRoot.querySelector("nr-dropdown") as { hide?: () => void } | null)?.hide?.();
    if (id === this.choiceId) { return; }
    // Announced, not applied. The console owns the selection — it is what the
    // next send reads — and an element that set its own property would be a
    // second owner of the same fact.
    //
    // Neither bubbling nor composed: the console binds this handler on the
    // element itself, which keeps working wherever the element is moved to. A
    // composed event would instead climb out through nr-chatbot's shadow root
    // and past the console's own delegated click handler on it.
    this.dispatchEvent(new CustomEvent("pick-choice", { detail: { id } }));
  }

  private row(c: ModelChoice) {
    return html`
      <button class="row" role="menuitem" @click=${() => this.pick(c.id)}>
        <div class="body">
          <div class="name">
            <!-- An automatic choice reads differently from a fixed one: the
                 model it runs is decided per message. The row says which it
                 is, rather than the console guessing from which of two ids the
                 engine filled in - the wire does not carry those at all. -->
            ${c.kind === "router" ? html`<nr-icon name="shuffle" size="small"></nr-icon>` : nothing}
            <span>${c.label}</span>
            <!-- "diamond", not "lock", and both halves of that are deliberate.
                 There IS no lock in the icon set (checked against
                 icon-paths.js, 151 names), and nr-icon draws the NAME when it
                 has no glyph for it - so name="lock" would print the word lock
                 in the middle of the menu, which is the exact failure
                 app/CLAUDE.md records. And a padlock would promise a refusal
                 this menu never performs: the premium mark is a label on the
                 row, enforcement is at the messages POST, and today nothing
                 anywhere enforces it. A diamond says priced; a padlock would
                 say forbidden, and it would be lying. -->
            ${c.tier === "premium"
              ? html`<nr-icon class="tier" name="diamond" size="small" title="Premium"></nr-icon>`
              : nothing}
          </div>
          ${c.description === "" ? nothing : html`<div class="why">${c.description}</div>`}
        </div>
        <span class="mark">
          ${c.id === this.choiceId ? html`<nr-icon name="check" size="small"></nr-icon>` : nothing}
        </span>
      </button>`;
  }

  render() {
    // No rows, no control. A community box with one model has no decision to
    // offer, and an empty menu behind a chevron is worse than no chevron
    // (MODEL-CHOICE.md: "A single-model install gets no picker rather than a
    // broken one"). The console also declines to dock it in that case, so this
    // is belt and braces rather than the only guard.
    if (this.choices.length === 0) { return nothing; }
    return html`
      <nr-dropdown trigger="click" placement="top-end" animation="scale"
        title="The model for the next message">
        <button slot="trigger" class="trigger" aria-haspopup="menu">
          <span class="long">${this.showing()}</span>
          <span class="short">${this.showingShort()}</span>
          <nr-icon name="chevron-down" size="small"></nr-icon>
        </button>
        <div slot="content" class="menu" role="menu">
          ${this.offered().map((c) => this.row(c))}
          ${this.premium().length === 0 ? nothing : html`
          <hr />
          <!-- Announced, not offered — and now the ENGINE's rows, not a list
               here: tier "premium" rows ride the same wire as the menu, the
               messages POST refuses them with "coming soon", and this just
               draws that truth. Display-only so nobody is offered a press
               that can only end in a refusal. -->
          <div class="soon-head">Coming soon</div>
          ${this.premium().map((c) => html`
            <div class="row soon">
              <div class="body"><div class="name"><span>${c.label}</span>
                <nr-icon class="tier" name="diamond" size="small"></nr-icon></div></div>
            </div>`)}`}
          <hr />
          <!-- The way back to "". Under a divider because it is not one of the
               operator's rows: it is the absence of a choice, which is what
               every conversation opened before this feature already carries. -->
          <button class="row" role="menuitem" @click=${() => this.pick("")}>
            <div class="body"><div class="name">${this.defaultRow()}</div></div>
            <span class="mark">
              ${this.choiceId === "" ? html`<nr-icon name="check" size="small"></nr-icon>` : nothing}
            </span>
          </button>
        </div>
      </nr-dropdown>
    `;
  }
}

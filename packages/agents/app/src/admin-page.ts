// The frame around settings when settings is a page.
//
// One element for both routes — /admin and /admin/<tab> — because the only
// difference between them is which tab the loader named, and two page modules
// each drawing their own header is two headers to keep in step.
//
// What is here is exactly the chrome an overlay got for free and a page does
// not: a way back. An overlay has a close button and the conversation behind
// it; a page has neither, and the first version of this shipped with no exit
// at all — the browser's back button was the only way out of Settings, which
// is the kind of thing that reads as the app having swallowed you.

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
// ui.js registers the LumenUI bundle set, in the one order that works — the
// header's nr-icon comes from there, and settings.js does not pull it in on
// its own.
import "./ui.js";
import "./settings.js";
import { BRAND } from "./brand.js";

@customElement("admin-page")
export class AdminPage extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%;
            background: var(--bg); color: var(--fg); }
    /* A thin bar, not a banner. The subject of this page is the settings
       below it, and a tall header on a page whose content is a table is
       furniture that scrolls nothing. */
    header { flex: none; display: flex; align-items: center; gap: 14px;
             padding: 10px 18px; border-bottom: 1px solid var(--border);
             background: var(--bg-rail); }
    .back { display: inline-flex; align-items: center; gap: 7px;
            padding: 6px 10px 6px 8px; border-radius: 9px;
            border: 0; background: none; font: inherit; font-size: 14px;
            color: var(--muted); cursor: pointer;
            transition: background-color .15s cubic-bezier(.23,1,.32,1),
                        color .15s cubic-bezier(.23,1,.32,1); }
    .back:hover { background: var(--bg-sunken); color: var(--fg); }
    .mark { font-weight: 650; letter-spacing: -.01em; font-size: 15px;
            color: var(--fg); }
    /* The one place this page says what it is. The rail below repeats it as a
       group label, which is why this is not also a title. */
    .where { color: var(--faint); font-size: 14px; }
    .grow { flex: 1; min-height: 0; }
  `;

  /* Which tab is open, by its display name — the page module has already
     turned a URL slug into one. */
  @property({ type: String }) tab = "Models";

  render() {
    return html`
      <header>
        <!-- location.assign and not history.back(): a person who arrived here
             from a pasted link has no history to go back to, and the button
             would do nothing at all for them. Home is a place, so this goes
             to it. -->
        <button class="back" @click=${() => { location.assign("/"); }}>
          <nr-icon name="chevron-left" size="small"></nr-icon>
          <span class="mark">${BRAND}</span>
        </button>
        <span class="where">Settings</span>
      </header>
      <console-settings class="grow" page zone="admin" .tab=${this.tab}></console-settings>
    `;
  }
}

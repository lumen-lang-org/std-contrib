import { LitElement, css, html } from 'lit';

// The console is a full-bleed application, so the root layout adds no chrome
// at all — it exists to hold the height chain open and to be the seam where
// phase 4's AUTH dispatch will hang. Anything drawn here would show up in the
// Kimi design as something index.html did not have.
export class LayoutRoot extends LitElement {
  // The height chain, continued — see the note in head.html for why these are
  // sized boxes and not `display: contents`.
  static styles = css`
    :host { display: block; height: 100%; }
    ::slotted(*) { display: block; height: 100%; }
  `;

  render() {
    return html`<slot></slot>`;
  }
}

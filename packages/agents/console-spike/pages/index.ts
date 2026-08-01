import { LitElement, css, html } from 'lit';

// The whole console, unmodified. `src` is a symlink to the shipping app's
// src/, so this is the same `console.ts` the Vite build serves — not a copy
// that can drift. It pulls in ui.ts (the LumenUI bundle set) on the way.
//
// Imported dynamically and behind a guard, which is not a style choice. A
// page module in LumenJS is evaluated on the server too — for SSR, and, less
// obviously, by the Socket.IO plugin, which loads the page file to find its
// `socket()` export. A static import here drags the entire browser UI into
// Node, where the LumenUI bundle chain reaches a CommonJS `module` reference
// and throws. The visible symptom is not an SSR warning: it is the socket
// handler never registering, because the load that would have found
// `socket()` threw first.
//
// The guard is `import.meta.env.SSR`, not `typeof window`. @lit-labs/ssr
// installs a DOM shim before rendering, so `window` IS defined on the server
// and a window check lets the import through — where highlight.js (reached
// via the LumenUI canvas bundle) hits `module is not defined` inside Vite's
// SSR module runner. That rejection is not caught by LumenJS's "fall back to
// CSR" path: it takes the dev server process down. `import.meta.env.SSR` is
// a compile-time constant, so the branch is removed from the server graph
// instead of merely skipped at runtime.
if (!import.meta.env.SSR) {
  import('../src/console.js');
}

// Proof 3. A page-level socket route: LumenJS sees this export, opens a
// Socket.IO namespace for `/`, and spreads whatever `push()` sends onto this
// element's declared properties. Phase 3 replaces the interval with the
// engine poll fan-out; the shape of the seam is what is being tested here.
export function socket({ push }: { push: (data: unknown) => void }) {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    push({ pushedTitle: `pushed title #${n}`, pushedAt: new Date().toISOString() });
  }, 1000);
  return () => clearInterval(timer);
}

export class PageIndex extends LitElement {
  static properties = {
    pushedTitle: { type: String },
    pushedAt: { type: String },
  };

  pushedTitle = '';
  pushedAt = '';

  static styles = css`
    /* The last link in the height chain — see head.html. The probe below is
       position:fixed, so it needs no positioned ancestor. */
    :host { display: block; height: 100%; }
    /* A spike-only readout. Nothing like it survives into phase 3 — the
       pushed title lands on the sidebar row there. It is fixed and tiny so
       it cannot disturb the console's own layout while both are on screen. */
    .socket-probe {
      position: fixed; right: 8px; bottom: 8px; z-index: 9999;
      font: 11px/1.4 ui-monospace, monospace;
      background: rgba(0,0,0,.8); color: #fff;
      padding: 4px 8px; border-radius: 6px;
    }
  `;

  render() {
    return html`
      <agent-console></agent-console>
      <div class="socket-probe" data-testid="socket-probe">
        ${this.pushedTitle ? `${this.pushedTitle} @ ${this.pushedAt}` : 'socket: waiting'}
      </div>
    `;
  }
}

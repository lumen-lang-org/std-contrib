import { h as i, p as i$1, T } from "../assets/lit-shared-DAUlt8Vu.js";
function socket({ push }) {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    push({ pushedTitle: `pushed title #${n}`, pushedAt: (/* @__PURE__ */ new Date()).toISOString() });
  }, 1e3);
  return () => clearInterval(timer);
}
const _PageIndex = class _PageIndex extends i {
  constructor() {
    super(...arguments);
    this.pushedTitle = "";
    this.pushedAt = "";
  }
  render() {
    return T`
      <agent-console></agent-console>
      <div class="socket-probe" data-testid="socket-probe">
        ${this.pushedTitle ? `${this.pushedTitle} @ ${this.pushedAt}` : "socket: waiting"}
      </div>
    `;
  }
};
_PageIndex.properties = {
  pushedTitle: { type: String },
  pushedAt: { type: String }
};
_PageIndex.styles = i$1`
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
let PageIndex = _PageIndex;
if (!customElements.get("page-index")) {
  customElements.define("page-index", PageIndex);
}
export {
  PageIndex,
  socket
};

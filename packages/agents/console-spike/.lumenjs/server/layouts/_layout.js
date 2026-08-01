import { h as i, p as i$1, T } from "../assets/lit-shared-DAUlt8Vu.js";
const _LayoutRoot = class _LayoutRoot extends i {
  render() {
    return T`<slot></slot>`;
  }
};
_LayoutRoot.styles = i$1`
    :host { display: block; height: 100%; }
    ::slotted(*) { display: block; height: 100%; }
  `;
let LayoutRoot = _LayoutRoot;
if (!customElements.get("layout-root")) {
  customElements.define("layout-root", LayoutRoot);
}
export {
  LayoutRoot
};

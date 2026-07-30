// The root layout: what index.html's <head> used to be, minus the parts that
// are still static — those live in head.html, which the framework inlines
// before first paint.
//
// The console is a full-bleed application, so this layout adds no chrome at
// all. It exists to hold one deployment fact, and to be the seam where phase
// 4's AUTH dispatch will hang. Anything drawn here would show up in the Kimi
// design as something index.html did not have.
//
// The height chain runs through this element too, but its rule lives in
// head.html with the other three links rather than as a `:host` block here —
// see the note there.

import { LitElement, html } from "lit";

// Where artifacts are served from, if anywhere.
//
// An artifact is a body a model wrote, and it renders as itself only on a
// host that holds nothing worth stealing — the one named by the API's
// AGENTS_PREVIEW_HOST. Empty means "nowhere is isolated", and the console
// then reads previews through /api, where the server answers text/plain
// and the bytes are inert. That is the safe default: a deployment without
// a separate host for artifacts does not get to render them.
// Set both to the same host, or neither.
//
// The preview host rides the same Cloudflare tunnel as the console, so it
// is https like the console — a plain-http origin here is mixed content
// inside the https console, and the browser blocks the frame outright.
//
// index.html wrote this as a <meta> tag and `previewOrigin()` in src/api.ts
// reads it back off the document. That seam does not move — the answer still
// belongs to the deployment rather than to the build, and the tag is still
// what the client reads, so src/api.ts is untouched. What changes is who
// writes the tag: a server-side loader, so an operator can set the origin per
// deployment instead of editing a file baked into the image. The default is
// the exact string index.html shipped, so a console started with no
// environment at all behaves as it does today.
const DEFAULT_PREVIEW_ORIGIN = "https://lumen-artifacts.the-agent.dev";

export function loader() {
  return {
    previewOrigin: process.env.AGENTS_PREVIEW_ORIGIN ?? DEFAULT_PREVIEW_ORIGIN,
  };
}

export class LayoutRoot extends LitElement {
  static properties = {
    previewOrigin: { type: String },
  };

  previewOrigin: string = DEFAULT_PREVIEW_ORIGIN;

  connectedCallback(): void {
    super.connectedCallback();
    this.#writePreviewMeta();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("previewOrigin")) this.#writePreviewMeta();
  }

  // Written into document.head rather than templated, because a layout
  // renders into its shadow root and <head> is not reachable from there —
  // and api.ts asks the *document* for the tag, which is the same place it
  // asked when index.html carried it.
  //
  // This runs before the console can read it: the layout is the outermost
  // element the router mounts, and page-index only starts fetching the
  // console module after that. `previewUrl()` is called later still, when
  // an artifact is actually rendered.
  #writePreviewMeta(): void {
    if (typeof document === "undefined") return;
    let tag = document.querySelector<HTMLMetaElement>(
      'meta[name="agents-preview-origin"]',
    );
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "agents-preview-origin");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", this.previewOrigin ?? "");
  }

  render() {
    return html`<slot></slot>`;
  }
}

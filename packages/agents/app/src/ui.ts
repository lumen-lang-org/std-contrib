// LumenUI registrations. The chatbot declares requiredComponents but its
// bundle does not carry them; each must be registered by the page. One file,
// so the list exists in exactly one place.
//
// Each `<component>/bundle.js` inlines its own copy of everything it depends
// on, and a tag may only be defined once — so two bundles that share a
// dependency cannot both be imported. The canvas bundle is the widest one
// here: it already carries nr-chatbot, nr-input, nr-button, nr-icon,
// nr-select and nr-popconfirm, so importing their own bundles alongside it
// threw `define(...) has already been used`. That throws while the module
// graph is loading, which left the whole console blank rather than just the
// canvas — the failure did not look like an import problem at all.
//
// What remains is what the canvas bundle does not define: the two other
// components the chatbot asks for.
//
// The package's single `@nuraly/lumenui/bundle` would sidestep the whole
// question and was tried first: it imports `hls.js`, which the package
// declares as a dependency of no kind, so it cannot resolve.

// Order is load-bearing now, in a way it was not with the bundles.
//
// Each `<component>/bundle.js` inlined everything it depended on, so any one
// import registered a whole subtree and the sequence never mattered — what
// mattered was that two bundles must not both inline the same tag, which is
// the double-define trap this file used to be about.
//
// The per-component entries inline nothing. They declare `requiredComponents`
// and check them, so a composite imported before its parts throws "Required
// component nr-icon is not registered" during module load — and a throw there
// blanks the whole console, not the one component. So: primitives first,
// composites after, and nothing here reordered casually.
import "@nuraly/lumenui/icon";
import "@nuraly/lumenui/button";
import "@nuraly/lumenui/input";
import "@nuraly/lumenui/checkbox";
import "@nuraly/lumenui/textarea";
import "@nuraly/lumenui/dropdown";
import "@nuraly/lumenui/modal";
import "@nuraly/lumenui/overlay";
// Composites: each of these needs some of the above already registered.
import "@nuraly/lumenui/select";
import "@nuraly/lumenui/popconfirm";
// Browser-only, and `ssr.external` is not the lever for it.
//
// codejar's first line is `const globalWindow = window`, evaluated on import.
// Externalising the specifier only changes WHO loads it — Node then evaluates
// the same line and throws the same ReferenceError, which is why an
// ssr.external entry for it made no difference at all. The module simply must
// not be loaded on the server.
//
// The cost is nothing: nr-code-editor is the prompt editor in Settings, a
// surface that exists only after a click, and a component registered a tick
// later than the rest is indistinguishable from one registered with them.
if (!import.meta.env.SSR) {
  void import("@nuraly/lumenui/code-editor");
}
// Browser-only, for the same reason and by the same route: canvas carries
// nr-code-editor (see this file's history and app/CLAUDE.md), so it reaches
// codejar and its `const globalWindow = window` — guarding the code-editor
// import alone changed nothing while canvas still pulled it in.
//
// The agent graph is a view you navigate to, so nothing on a first paint
// needs it.
if (!import.meta.env.SSR) {
  void import("@nuraly/lumenui/canvas");
}
import "@nuraly/lumenui/chatbot";

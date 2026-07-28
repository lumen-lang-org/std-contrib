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
import "@nuraly/lumenui/canvas/bundle";
import "@nuraly/lumenui/dropdown/bundle";
import "@nuraly/lumenui/modal/bundle";
// Neither of these is in the canvas bundle, and neither collides with it.
import "@nuraly/lumenui/checkbox/bundle";
import "@nuraly/lumenui/textarea/bundle";
// A surface to work on, as opposed to nr-modal's question to answer. Settings
// is the former: it is a place you go, not a thing you confirm.
import "@nuraly/lumenui/overlay/bundle";
// nr-code-editor — the prompt editor — is deliberately *not* imported here.
// The canvas bundle already carries it, and importing its own bundle as well
// threw `define("nr-code-editor") has already been used` before the console
// had drawn anything at all. Widening the list above is how this file breaks;
// grep a bundle for the tag before adding it.

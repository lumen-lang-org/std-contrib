// Spike config.
//
// `integrations` is deliberately EMPTY, and the reason matters for phase 2:
//
// - 'nuralyui' must NOT be enabled. It rewrites `@nuraly/lumenui/<component>`
//   onto source files in a sibling `libs/nuraly-ui` checkout, which does not
//   exist in std-contrib — and because Vite aliases match on a path prefix,
//   `@nuraly/lumenui/canvas` also captures the console's
//   `@nuraly/lumenui/canvas/bundle` and resolves it to
//   `<src>/canvas/index.ts/bundle`. The console consumes the published
//   package's prebuilt bundles, so it wants no aliasing at all.
// - 'communication' pulls in the chat schema and wants a database. The socket
//   proof below needs none of that: page `socket()` exports are wired by
//   lumenSocketIOPlugin, which the dev server registers unconditionally.
// - 'auth' arrives in phase 4, not here.
export default {
  title: 'Agent Console (spike)',
  integrations: [],
};

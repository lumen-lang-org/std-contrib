// The console's project config. Read as text at startup rather than evaluated
// — `readProjectConfig` scrapes the fields below out of this file with regular
// expressions (dev-server/config.ts) — so nothing here may depend on the
// environment, and every value has to be a literal.

export default {
  // Same string index.html carried in its <title>.
  title: "Agent Console",

  // No integrations, and `nuralyui` is the one that has to stay off.
  //
  // The integration adds two things. The first is an alias table pointing
  // `@nuraly/lumenui/*` at a checkout of the library's source under
  // `libs/nuraly-ui`; this repo has no such checkout, so the alias would
  // resolve to nothing and the package's own exports would answer anyway —
  // it buys nothing here.
  //
  // The second is an auto-import transform that rewrites every `.ts` under
  // the project: it scans for `<nr-...` in a template and prepends an import
  // of that component's package. That is the LumenUI double-define trap
  // (app/CLAUDE.md) fired automatically and on every file. `src/ui.ts` holds
  // the one combination of bundles that can coexist; a transform that adds
  // `import "@nuraly/lumenui/icon"` to `console.ts` because the word
  // `<nr-icon` appears there would define a tag the canvas bundle has already
  // defined, throw during module load, and blank the console — the exact
  // failure ui.ts's comment block was written about.
  //
  // So registrations stay where they are: one file, one list, hand-checked.
  //
  // `auth` is the other one that has to stay off, and for a reason that has
  // nothing to do with the first. It would mount the framework's session
  // middleware AFTER the global `lumenjs.server.js` chain — which is where
  // server/api-proxy.ts lives — so the identity would be established after the
  // request it identifies had already gone upstream. `AUTH=builtin` drives
  // LumenJS's auth pieces directly instead, ahead of the proxy; the full
  // reasoning, and the two other things that fall out of it, are at the top of
  // server/auth-builtin.ts.
  //
  // It could not be conditional in any case: `readProjectConfig` scrapes this
  // array out of the file with a regular expression rather than evaluating the
  // module, so a `process.env.AUTH` here would be read as no integrations at
  // all — and on would mean on in all three modes.
  integrations: [],

  // Where `AUTH=builtin` keeps its users.
  //
  // Named for what it holds, because the one thing that must never be true of
  // this file is that it points at the engine's database. The engine is
  // another process behind AGENTS_API with its own schema, its own migrations
  // and its own idea of what a row belongs to; a users table in there would
  // couple the console's login to the engine's release cycle and put a
  // password hash in a database this app does not own. `DATABASE_URL` moves
  // this to Postgres — the community compose already runs one — and it must
  // point at a database of this app's own for exactly the same reason.
  //
  // Unread in `none` and `proxy`: nothing opens a database in those modes.
  db: { path: "data/console-auth.sqlite" },

  // Nothing in this app is a link the router prefetches — it is one page.
  prefetch: "none",
};

# Backlog

What is worth doing next, and why — kept here rather than in a conversation
because conversations get compacted and this does not. One heading per item,
newest at the top of its section. Delete an item when it ships; a done list
belongs in git history.

## Bugs

### An .xlsx preview serves raw base64 to the browser

`lumen-artifacts.the-agent.dev/preview/<id>?v=1` on a workbook answers a wall
of base64 text instead of a document. The docx path does not do this: it goes
through the LibreOffice converter (`office-render.ts`) and `src/office-view.ts`
draws the PDF, falling back to docx-preview. Whatever answers `/preview` for a
workbook is handing back the stored body with the wrong content type and no
renderer in front of it. A workbook is never converted to PDF *on purpose*
(CLAUDE.md: paginating a sheet is worse than the table), so the fix is the
SheetJS view the artifact panel already has, reached from the preview route —
not a second converter.

### The connector shelf posted a server with no id

Fixed (2026-08-02) — the gallery card's Add built a row from `NEW_SERVER`,
whose `id` is `""` because the form asks a person to type one. Kept here as
the reason ids are derived from the name now.

## Features

### A live spreadsheet editor — v1 SHIPPED (2026-08-02); grid library still open

Shipped: the panel's workbook table is editable in place. Cells are
contenteditable, dirty cells carry ink, a save bar appears with the count,
and Save patches ONLY the changed cells inside the original zip
(src/xlsx-patch.ts) before landing the file as a new artifact version through
the upload door — so styles, charts and conditional formatting survive
byte-identical (asserted by e2e/sheet-edit.spec.ts), and the version history
keeps both whole bodies the way EDIT-DIFF.md wants. Typing over a formula
replaces it with the literal and drops calcChain, which Excel rebuilds.

Still open, in order of value:
- **A wide mode for editing.** The artifact rail is ~300px of table; editing
  wants most of the window while it lasts.
- **A real grid** (Univer was the strongest candidate — Apache-2.0, formulas,
  closest to Excel) if in-cell formulas/recalc are ever wanted. Its own xlsx
  export is lossy the same way SheetJS's is, so the zip-patch write path
  stays regardless of grid.
- Column widths and number formats in the table (the grid draws raw values).

### Tooltips with their keyboard shortcut (asked again 2026-08-02 — next up)

Kimi and Claude both label an icon button on hover with a dark tooltip that
carries the shortcut as key chips — "Hide Sidebar ⌘ B". Ours have `title`
attributes, which are slow, unstyled, and never show the shortcut. Wanted: one
tooltip element, used by every icon button in the rail, the header (New
conversation, the three-dot menu, Artifacts) and the composer, with the chips
rendered from a key list rather than typed into the string.

### Plugins that update

A plugin records the manifest URL it was installed from but never reads it
again. Re-install is remove-then-add, which throws away a connector's token.
Wanted: a re-read that diffs the manifest against the receipts — new skills
added, removed ones deleted, changed bodies updated, connectors left alone
because their tokens are the operator's.

### Social sign-in: Google, LinkedIn, GitHub (investigated 2026-08-02)

LumenJS auth supports it natively for two of the three. Its `providers` array
takes `NativeProvider` (today's email/password) plus any number of
`OIDCProvider`s, resolved through OIDC discovery (`/.well-known/
openid-configuration`) — and it ships a pre-built `googleProvider`.

- **Google**: first-class. `googleProvider({ clientId })` in lumenjs.auth.ts.
- **LinkedIn**: works through the generic OIDC shape — LinkedIn publishes a
  discovery document ("Sign In with LinkedIn using OpenID Connect", issuer
  `https://www.linkedin.com/oauth`).
- **GitHub**: NOT expressible today. GitHub is plain OAuth2 — no discovery
  document, no id_token — and the framework's client resolves everything
  through discovery (auth/oidc-client.js). Needs a framework extension
  (custom endpoints on the provider type) or a small proxy that speaks OIDC
  in front of GitHub.

Where it lands: prod signs in through the nuraly social app behind the
gateway (`/__nk_auth/*`), so the provider config belongs in THAT app's
lumenjs.auth.ts (nuraly repo — no-commit rule) and the sign-in card grows
provider buttons. Blocked on: OAuth client id/secret for each provider from
their consoles, with callback `https://lumen-agents.the-agent.dev/__nk_auth/
callback/<provider>` (exact route per framework config).

## Known and waiting on a decision

- ~~Non-admin 403s~~ — fixed 2026-08-02: signed-in users can read
  /models/choices and the five user-zone tables; writes still admin until
  authorship is scoped per owner.
- **Five live/live-fanout e2e failures** — socket answers, polling fallback and
  fan-out broken. Untriaged.
- **SSR serves stale CSS until a restart** — unexplained.
- **The vendored LumenUI tarball is a release behind** — one repack before any
  release image is built. The dev loop uses the symlink and does not care.

## Asked for, not started

### The user zone's engine routes are still admin-gated (shipped 2026-08-02: the three-surface split)

Settings now splits by whose setting it is: Preferences (theme, account) and
the user Settings overlay (Agents, Prompts, Skills, Templates, Connectors,
Plugins) for people; `/admin/<tab>` (Models, Model menu, Providers, Images,
MCP, Tracing) for the operator, admin-gated at the gateway.

What remains is the gateway: the engine routes the USER zone calls —
/skills, /servers, /agents writes, /prompts, /templates, /plugins — still fall
to the admin catch-all, so a non-admin sees the overlay but gets 403s inside
it. Same shape as the known /api/models/choices 403. Opening those routes to
signed-in users (owner-scoped where relevant) is one gateway change plus a
decision about who may author what.

### A token belongs to a person, not the deployment — SHIPPED a42c20b (2026-08-02)

Done: per-user token under mcp:<server>:u:<owner> with deployment fallback,
runs carry the thread owner's token, /servers/:id/mine routes, Your-access UI
on the Connectors tab, e2e + unit coverage. Still open: the OAuth half —
signing in instead of pasting — which waits on the social-login providers
above (same framework machinery) and on client credentials.


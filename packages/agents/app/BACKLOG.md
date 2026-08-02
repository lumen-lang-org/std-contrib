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

### Joule's own sign-in — built 2026-08-02 (adaab0e), NOT yet cut over

What exists: auth_providers + an encrypted client secret, a Sign-in tab in
/admin, and server/auth-builtin.ts handing the configured OIDC providers to
the same LumenJS auth module that already serves the password form. Google and
LinkedIn work through generic OIDC. Verified end to end on prod's engine.

What is NOT done, in the order it blocks going live:

1. **The cutover, and it is the real one.** Prod runs AUTH=proxy, so every
   conversation is owned by a nuraly user id — 845 of them belong to one
   uuid. Flipping to AUTH=builtin mints new identities and those conversations
   stop being anybody's. Needs: create the builtin account carrying the SAME
   uuid (the users table takes an id, so this is possible), or a one-off
   owner remap in the engine. Rehearse on a second console instance before
   prod. Nothing else here matters until this is decided.

2. **No mailer, so no password reset.** authConfig sets
   requireEmailVerification: false precisely because nothing can send mail.
   A social-only account (password_hash '') has no password to reset either.
   For a real user base that is a lockout waiting to happen. The nuraly app
   solved this with system-mailer.js and an onEvent hook; this app needs the
   same, or SMTP settings on the Sign-in tab.

3. **Client credentials.** A client id and secret from each provider's
   console, with the callback the tab prints. Ours to ask for, not to build.

Then the quality-of-life half:

4. **Identity records and a profile screen.** The framework links accounts by
   VERIFIED EMAIL only (linkOidcUser): same email, same account, roles merged;
   unverified email never links, which is the anti-takeover rule. But there is
   no identities table — the users row is id/email/name/password_hash/roles —
   so nothing can say which providers an account has used, nothing can unlink
   one, and a personal Gmail beside a work address is silently two accounts
   with two sets of conversations. A profile needs: an identities table
   (user, provider, subject, linked_at), writes to it in the OIDC callback, and
   a Preferences section listing them with add/unlink. That is a real feature,
   not a screen over existing data.

5. **GitHub.** Plain OAuth2, no discovery document, so the framework's OIDC
   client cannot express it. Needs a small provider shim (authorize/token/user
   endpoints by hand) or a proxy that speaks OIDC in front of it.

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


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

### A live spreadsheet editor

Today a workbook is read-only: SheetJS renders it and edits go through the
model. Editing cells in the browser needs a real grid. Candidates to evaluate,
in the order they look promising:

- **Univer** (Apache-2.0, the Luckysheet team's rewrite) — formulas, formats,
  a docs/sheets/slides suite, actively developed. Heaviest, closest to Excel.
- **x-spreadsheet** (MIT) — small, canvas grid, no formula engine to speak of.
  Fine for typing values, not for a model.
- **Handsontable** — excellent grid, but non-free for commercial use; the
  license is the whole decision.
- **Jspreadsheet CE** (MIT core) — middle weight, formulas via formula.js.

What matters more than the grid: the write path. An edit has to land as an
artifact version the way a document edit does, or two people editing produce a
last-writer-wins mess. Read EDIT-DIFF.md before choosing.

### Tooltips with their keyboard shortcut

Kimi and Claude both label an icon button on hover with a dark tooltip that
carries the shortcut as key chips — "Hide Sidebar ⌘ B". Ours have `title`
attributes, which are slow, unstyled, and never show the shortcut. Wanted: one
tooltip element, used by every icon button in the rail and the composer, with
the chips rendered from a key list rather than typed into the string.

### Plugins that update

A plugin records the manifest URL it was installed from but never reads it
again. Re-install is remove-then-add, which throws away a connector's token.
Wanted: a re-read that diffs the manifest against the receipts — new skills
added, removed ones deleted, changed bodies updated, connectors left alone
because their tokens are the operator's.

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

### A token belongs to a person, not the deployment

A connector's token is stored once, encrypted, under the server's id, and
every user's calls go out with it. That is right for a company Jira and wrong
for a GitHub PAT: one person's account, one person's rate limit, one person's
audit trail. What is missing is a per-user credential — the same encrypted
store keyed by (server, owner), with the deployment-wide one as a fallback —
and an OAuth flow so the usual case is signing in rather than pasting a token.
The "Authorised apps" section in Connectors is the empty space this fills.


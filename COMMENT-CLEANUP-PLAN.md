# Plan: strip AI narration comments, keep only necessary ones

> **Phase 2 done (2026-08-03), and its finding is the interesting part:** the
> engine blocks in scope — the search guard, the auth-provider rows, the
> `kind` column — already passed this plan's own delete-test. Unlike the
> lumenjs essays of Phase 1, they carry constraints (frozen V1 mappings, the
> secret-store location, dash's cryptic `(` error) with little prose around
> them. One header trimmed of two rhetorical clauses (`AuthProviderRow`);
> nothing else met the CUT bar. Phase 3 remains gated on an explicit
> go-ahead, and this result argues for skipping it: the engine's comment
> style is already the KEEP list.

## The rule (what stays vs what goes)

From the repo's own standard: *a comment earns its place only when it states a
constraint the code cannot show.* Everything else is narration written for a
reviewer, and becomes noise the moment the change merges.

**KEEP** — a comment that, if deleted, loses information not in the code:
- A frozen invariant or ordering rule: "migrations are ordered as strings",
  "V1 mapping is checksummed — never edit, add an ALTER at a new version".
- A protocol/format quirk the code obeys but can't explain: "GitHub 403s
  without a User-Agent", "SESv2 wants SigV4", "dash reports the `(` at line 1".
- A magic constant's source or unit: why a timeout is 600s, why a cap is N bytes.
- A deliberate non-obvious choice that looks like a bug: "double-quoted
  `datetime('now')` is intentional here because…", "no backfill on purpose".
- A `TODO`/`flagged` marker pointing at real out-of-scope work.
- Public API doc that a consumer reads without opening the body (keep terse).

**CUT** — narration that restates or justifies code the reader can already see:
- What the next line does ("// enforce the output cap here on the host").
- Why the code is correct / an essay on the design ("// try is here, around the
  only fs writes materialise makes, because a throw…").
- History or motivation ("// Before this, linkOidcUser matched by email and
  wrote nothing…") — collapse to one line only if it encodes a live constraint.
- Restating a name ("// A prompt, versioned.") above `class Prompt`.
- Section-divider banners and ASCII rules that carry no constraint.

Test for each block: *delete it, then read the code. Did I lose a fact I could
not recover from the code itself?* If no → it goes. If yes → keep the fact, in
one line, drop the prose around it.

## Scope, by risk (do in this order, stop-and-verify between phases)

The narration is unevenly spread and not all from this session. Phasing keeps a
working prod codebase safe and lets us stop early if the return drops off.

**Phase 1 — framework files authored this session** (`libs/lumenjs/src/auth/*`,
`libs/lumenjs/src/email/*`, ~400 comment lines). Smallest, newest, all mine,
its own commit scope. Files: `auth/native-auth.ts`, `identities.ts`,
`token.ts`, `types.ts`, `routes.ts`, `routes/identities.ts`, `config.ts`,
`middleware.ts`, `oauth2-client.ts`, `providers/github.ts`, `providers/google.ts`,
`db.ts`, `email/{index,template-engine,auth-events,types}.ts`, `email/providers/*`.
Keep: the SigV4/User-Agent/verified-email-only/last-method-refusal/`linked_at`-
has-no-default constraints. Cut: the multi-paragraph file headers and the
why-this-is-safe essays.

**Phase 2 — engine files changed this session** (`packages/agents`): the parts
of `schema.ts`, `api.ts`, `run-script.ts` touched for the `kind` column, auth
providers, and the search path. Only the blocks I added — leave untouched code
alone in this phase.

**Phase 3 — engine house-style narration** (`schema.ts` 54%, `api.ts` 1574
lines, `threads.ts` 968, `run.ts`, `artifacts.ts`, `tools.ts`, …). This is the
big surface and predates this session. **Decision needed before starting Phase 3**:
this is thousands of lines across working prod code, and some of these comments
are the only place certain invariants are written down. Recommend: do Phase 3
file-by-file, only where the density is clearly narration, and NOT as a sweep.
Or skip Phase 3 entirely and keep it to session work (Phases 1–2). My default
recommendation: **Phases 1–2 now, Phase 3 only on explicit go-ahead.**

## Method

- **Manual, per file — never a regex/automated strip.** These comments hide real
  invariants; a blind `sed` will delete the frozen-mapping warning next to the
  banner. Read each block, apply the test above, rewrite kept facts to one line.
- Preserve every frozen/checksum/ordering note verbatim — those protect
  migrations already shipped to the prod DB.
- Do not touch code, only comments. Diff must be comment-only lines.

## Verify (per phase)

- Framework: `cd libs/lumenjs && npm run build && npx vitest run auth email`
  (the auth/email/identity/oauth2/github suites must stay green).
- Engine: `cd packages/agents && lumen test schema.test.ts api.test.ts
  run-script.test.ts` — the migration-count canaries must still pass (a deleted
  comment must not shift a checksummed migration).
- Then rebuild + restart the engine and console and confirm through the
  **gateway** (`https://lumen-agents.the-agent.dev`), not the dev server, that a
  chat + a run_script still work.

## Commit hygiene

- Framework: one commit, `libs/lumenjs` scope only, `refactor(lumenjs): trim
  narration comments to invariants`. CI owns the version — no `package.json` bump.
  Then rebuild the vendored tarball and reinstall into Joule.
- Engine: separate commit in `packages/agents`; do not commit into the nuraly
  repo. Comment-only diff, so no behavior change to review.

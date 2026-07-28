# Editing an artifact without resending it

What changing one line of a 400-line artifact should cost: the line, said twice.
Today it costs the whole file, twice — `read_artifact` returns the body entire,
`write_artifact` says of itself "this is not a patch: what you send is the new
version, entire" — and then keeps costing it, because `threads.ts` replays
stored call args into every later round until the turn falls off the
100,000-char budget (threads.ts:310). At the top of the range the loop breaks
outright: a body near `ARTIFACT_MAX` (524,288 bytes, ~131k tokens) cannot be
resent whole in one completion at all, which is the TRUNCATED fixture's exact
failure.

And the model can only change files it already knows about. The briefing lists
paths and titles, its overflow line says "list with read_artifact" — an
affordance that does not exist — and there is no way to search the
conversation's artifacts. A model that did not write a file this round cannot
find the line it is asked to change without reading every file it can name.

Two tools close both holes: `edit_artifact`, exact-substring replacement in the
Claude Code `Edit` shape, and `search_artifacts`, exact-substring search over
the thread's current bodies. This document is the contract for both.

## The choice, and why

Three shapes were designed in full before one was chosen.

**Exact substring, `old`/`new`** — Claude Code's `Edit`, adapted to versioned
rows. Taken as the spine, for two reasons that outweigh its known price. First,
the model already knows this shape: it is the edit loop every current model has
been trained on, and a tool whose shape the model must learn from a description
fails more often than one it has practiced. Second, the echoed `old` is a proof
of reading. The text must match the stored body byte for byte, so it can only
come from a `read_artifact` body or a `search_artifacts` hit — ground truth,
not memory. That proof is the load-bearing safety property of editing at all.

**Anchor pairs** — replace the region between two unique anchors, with an
`edited_from` version pin the model must supply. Rejected as the spine: the pin
proves the model knew a number, not that it read the body (that design's own
failure table says so), and it makes the model do version bookkeeping where
every stale guess costs a refusal round plus a reread. Two things are grafted
from it, named below.

**Server-side query with `occurrence` and `baseVersion`** — one call, the
server searches, a numbered refusal lets the model pick a match by index.
Rejected as the spine twice over: it deliberately does not solve discovery
(the query searches one known path; a model that does not know the path is
still blind), and `occurrence` is a wrong-place machine — the server cannot
distinguish an informed pick from a blind guess, and only prompt text stands
between the two. Two things are grafted from it too.

The grafts, so the credit lands where it belongs:

- **From the anchor design:** occurrences are counted *overlapping* — `"aa"`
  occurs twice in `"aaa"`, so it is ambiguous and refused. Non-overlapping
  counting would call it unique and splice the first two characters, a silent
  wrong-region edit hiding inside the uniqueness rule. Also from it: argument
  members are presence-checked with `jsonFind` before dispatch, because
  `jsonText` answers `""` for a missing member and a refusal must name the
  member that was absent, not complain that `old` was empty.
- **From the one-call design:** the success reply carries a context echo — the
  changed lines with two lines either side — because the wrong-site edit is
  this design's worst silent failure and the echo is its only tripwire. The
  multi-match refusal lists numbered hits *with snippets*, not bare line
  numbers, so widening `old` is a copy job rather than a fresh read. And every
  snippet quoted back into model context passes the `wireView` neutralisation
  (artifacts-fence.ts:345), because artifact bodies are untrusted and a
  refusal that quotes one must not become an injection vector.

**One split is deliberate and should be said plainly rather than averaged.**
The version-pin designs are right for the operator: they guarantee that every
version's parent was one the writer had provably fetched, and they serialize
concurrent editors hard. The substring design is right for the model: no
version bookkeeping, and a concurrent change *elsewhere in the file* merges
instead of costing a refusal, a reread, and a retry. This spec takes the
model's side at the tool surface and keeps the operator's guarantee inside the
transaction — the edit inserts its version row at exactly N+1, so a concurrent
append is detected by the database, and the retry re-reads and re-matches
against the new body. The one thing the operator loses relative to a pin is
the ability to say "this edit was computed against version 7 exactly"; what
they keep is an append-only log where no version is ever silently replaced.
There is deliberately no `expected_version` argument for the model — it would
be a fifth thing to get wrong, and the textual match is the stronger proof.

## The tools, as the model receives them

Two `ToolSpec` entries appended in `artifactTools()` (tools.ts:292), bringing
the surface to four. The comment at tools.ts:258 — "Two tools and not five" —
must be rewritten in the same change to say why exactly four: save, read, find,
change is the complete verb set for a file a model owns; listing, diffing and
rollback remain the person's, through the API. Left unrewritten, the comment
is a standing argument for reverting this spec.

    toolSpec("search_artifacts",
      "Find where something lives in this conversation's artifacts before you change it. "
      + "The query is matched as an exact substring - no patterns, no case folding, one line only - "
      + "against every artifact's path, title, and the body of its current version. "
      + "Each hit names the path, the version searched, and the matching line with its line number, "
      + "which is the text edit_artifact expects as old. "
      + "A line longer than 160 bytes comes back cut, ending in the marker [cut]; "
      + "never use a cut line as edit_artifact's old - read_artifact the file instead. "
      + "At most 20 hits, at most 5 per artifact; no hits is an answer, not an error, "
      + "and names how many artifacts were searched.",
      "{\"type\":\"object\",\"properties\":{"
      + "\"query\":{\"type\":\"string\",\"description\":\"The exact text to look for, 2 to 200 bytes of UTF-8, no newline. "
      + "Every length here is bytes, so a letter outside ASCII counts as more than one. "
      + "Substring only: 'a.*b' finds lines containing those four characters and nothing else.\"}},"
      + "\"required\":[\"query\"]}")

Every count the model is told is a byte count and says so. A string is UTF-8
bytes here, so a query written in Arabic is two bytes a letter and one written
in emoji is four; a limit reported as "characters" would be arithmetic the
model cannot reproduce — it counts 150 and is refused for 300.

    toolSpec("edit_artifact",
      "Change part of an existing artifact without resending the rest. "
      + "old is matched against the artifact's current version as an exact substring - every character, "
      + "including whitespace, quotes and indentation, exactly as read_artifact or search_artifacts returned it - "
      + "and replaced once with new, saved as the next version. "
      + "The call is refused when old matches nowhere (nothing is guessed or fuzzily matched; the refusal says "
      + "whether a whitespace-insensitive scan found a near miss and on what line) and refused when old matches "
      + "more than once (the refusal lists the matches with their lines and text; include more surrounding text "
      + "until the match is unique). "
      + "The reply names the slot, the new version number, and shows the changed lines with two lines around them - "
      + "read that reply; it is how you learn what actually changed in a file you did not reread. "
      + "If the refusal says the artifact changed while you were editing, read or search it again before retrying. "
      + "For a file that does not exist yet, or when most of a file changes, use write_artifact.",
      "{\"type\":\"object\",\"properties\":{"
      + "\"path\":{\"type\":\"string\",\"description\":\"The path the artifact was saved under, such as /report.html.\"},"
      + "\"old\":{\"type\":\"string\",\"description\":\"The exact text to replace, verbatim from the current version. "
      + "Must occur exactly once.\"},"
      + "\"new\":{\"type\":\"string\",\"description\":\"What replaces it. May be empty to delete the old text.\"},"
      + "\"note\":{\"type\":\"string\",\"description\":\"Why this version exists, in a few words.\"}},"
      + "\"required\":[\"path\",\"old\",\"new\"]}")

`note` is optional exactly as on `write_artifact`. Arguments are read with the
scan.ts members, never `JSON.parse<T>` — which is what lets an optional member
exist at all, since a Lumen record has no optional fields — and `old` and
`new` are presence-checked with `jsonFind` before anything else, so an omitted
or misspelled member is refused by name instead of arriving as `""`.

The briefing overflow line (artifacts.ts:692) changes in the same commit from
"list with read_artifact" to "search with search_artifacts". The old line is a
false affordance — read_artifact lists nothing — and it must not survive
alongside the tool that makes it true.

## The server surface

All in `packages/agents`, two new files. The namespace is flat, so every
exported name is prefixed — `edit` or `search` — the discipline that keeps two
modules from ever exporting one name. On the wire the fields are `old` and
`new`; in the record they are `oldText` and `newText`, because `new` is a
reserved word and the compiler would refuse the field — the scan.ts unpacking
is what decouples the two spellings. No failure path anywhere below throws:
a `throw` does not propagate out of a lambda, the fixpoint pass cannot see
through a function value, and a `try` in the dispatch loop would catch
nothing — so every failure is a returned `problem` string in `putArtifact`'s
`refusal()` idiom, and every scanner is a straight-line loop called directly.

    // artifacts-search.ts ----------------------------------------------------
    export type ArtifactHit = { path: string, slot: int, version: int, line: int, text: string, cut: bool };
    export type ArtifactSearch = { ok: bool, hits: ArtifactHit[], searched: int, capped: bool, problem: string };

    // SQL pre-filter with likeLiteral (knowledge.ts:195) over path, title and
    // the current body only - JOIN artifact_versions ON version =
    // current_version. Old versions are excluded on purpose: a hit against one
    // is a line edit_artifact can no longer match. The query must pass through
    // likeLiteral or a % or _ in it silently widens the LIKE. No transaction:
    // version rows are immutable, so the worst staleness is a hit against a
    // version that is no longer newest, which the edit's own match then refuses.
    export function searchArtifacts(db: Db, threadId: string, query: string): ArtifactSearch

    // Exact substring occurrences, counted OVERLAPPING, advancing by one:
    // "aa" in "aaa" is two hits, so it is ambiguous and refused - counted
    // non-overlapping it would be "unique" and splice the wrong region.
    // Hand-written charCode walk in the scan.ts idiom; bytes compared as they
    // are, nothing folded. Stops at most+1 so "more than most" is knowable
    // without walking a 512 KiB body to the end.
    export type EditHit = { at: int, line: int };
    export function editHits(body: string, needle: string, most: int): EditHit[]

    // The near-miss scanner behind the zero-match refusal: the same walk, both
    // sides skipping runs of space, tab and CR. Answers the line of the first
    // loose match or -1. It cannot see unicode normalization differences and
    // does not claim to.
    export function editLoose(body: string, needle: string): int

    export function editLineAt(body: string, at: int): int
    // 1-based, the lineEnd walk (artifacts-fence.ts:79).

    export function searchSnippet(lineText: string): ArtifactHit
    // Truncation at 160 chars on a UTF-8 boundary - argsPreview's walk-back off
    // continuation bytes (steps.ts:212), because a cut through a multi-byte
    // character poisons the row that quotes it - with a visible " [cut]" marker
    // so a copied snippet fails the exact match instead of splicing a line.

    // artifacts-edit.ts ------------------------------------------------------
    export type ArtifactEdit = {
      threadId: string, path: string,
      oldText: string, newText: string,   // wire names old/new; new is reserved
      note: string, turnSeq: int, now: string,
    };
    export type ArtifactEdited = {
      ok: bool, slot: int, version: int, line: int, bytes: int,
      context: string,       // the changed lines with two either side, when ok
      hits: ArtifactHit[],   // numbered matches, only on a multi-match refusal
      problem: string,
    };

    export function editArtifact(db: Db, edit: ArtifactEdit): ArtifactEdited
    export function editContext(body: string, from: int, to: int): string

`editArtifact` is a record argument, not seven positional strings, for the same
reason `ArtifactWrite` is (artifacts.ts:359). It runs as `editAttempt(db, edit,
attempt)` up to `WRITE_ATTEMPTS = 4`, mirroring `putAttempt` (artifacts.ts:430),
inside one transaction:

1. `getArtifact`. Missing path refuses in read_artifact's sentence
   (tools.ts:400); a `currentVersion` absent from the log refuses with the
   broken-pointer sentence (tools.ts:410) rather than editing an empty body.
   An edit never creates — so a typoed path cannot fork a second file the way
   a mistyped `write_artifact` path silently does.
2. `getVersion(id, currentVersion)`; call its number N.
3. `editHits(body, oldText, 8)`: zero hits refuses, with `editLoose` supplying
   "a whitespace-insensitive scan matches at line L" when it can; two or more
   refuses with the numbered hits, each carrying its `searchSnippet` line.
4. Refuse an empty `oldText` (it would match at position 0 of every body) and
   `oldText == newText` (a byte-identical version costs thread bytes, clutters
   the log, and teaches the model an edit "worked" when nothing changed).
5. Splice: `body.slice(0, at) + newText + body.slice(at + oldText.length)`.
   Re-run `putArtifact`'s byte checks on the result — `ARTIFACT_MAX`,
   `THREAD_BYTES_MAX` — refusing in the same words.
6. Explicit INSERT of the version row at exactly N + 1 — never `persist`,
   because persist upserts and an upsert on the append-only log is a silent
   overwrite (artifacts.ts:524). The unique index on `(artifact_id, version)`
   from migration 53 is the compare-and-swap: if anything appended N + 1
   between steps 2 and 6, this INSERT fails, the transaction rolls back, and
   `editAttempt` retries — re-reading the NEW body and re-matching `oldText`
   against it. See the next section for what that means.
7. Pointer: a column-scoped UPDATE of `current_version` and `updated_at` only,
   never a full-row persist — a full-row persist is exactly how the rotate bug
   rewound a pointer and orphaned a version (api.ts:1351). Title, kind, mime,
   slot and previewToken are untouched: an edit has no opinion about metadata.
8. Commit. The reply names slot, version, byte count and line, then the
   `editContext` block — passed through `wireView` neutralisation, as is every
   snippet in every refusal, because the quoted content is an artifact body
   and an artifact body is untrusted.

`callArtifactTool` (tools.ts:350) grows the two dispatch branches. `origin` is
fixed at `"generated"` at the call site, never read from the arguments, for the
reason the comment at tools.ts:369 already gives. A `note` absent from the call
is synthesized as "edit at line L", so the human version log never shows a
blank reason for a machine-made version.

## Two rounds, one path

The edit inserts at exactly N + 1 and lets the unique index arbitrate. When a
delegated child, a console upload, or a parallel round lands N + 1 first, the
edit's INSERT fails, the transaction rolls back, and the retry re-reads the
winner's body and re-matches `old` against it:

- The concurrent change touched *other* lines: `old` still matches exactly
  once, and the edit lands cleanly on top as N + 2. No refusal, no reread by
  the model, and the winner's version is a real parent, not a casualty.
- The concurrent change touched *the edited region*: the re-match finds zero
  hits or several, and the model is told the artifact changed underneath it —
  refused, never silently overwritten.

Either way a version row, once written, is never replaced — the property the
retry preserves and a naive "recompute the number and insert again with the
same body" would not, because for an edit the body was computed *from* a base,
and re-inserting it blindly past a new version is the stale-base overwrite
itself. The retry here recomputes the splice from the new body or refuses;
it never replays the old splice.

Named honestly: `write_artifact` still has the lost-update gap this closes.
Two rounds that both rewrite a path whole will still stack the loser's stale
body on top of the winner's as the newer version. Fixing that means a version
pin on `write_artifact`, which is an operator-visible contract change to an
existing tool, and it is out of this spec's scope — but it is a gap, not a
feature, and the survey that found it stands.

## The migration

None. Both tools read and write the existing tables, and the next free
version — 64 — stays free, deliberately. A search index (pg_trgm or a
tokenized side table) would need its DDL written out literally and frozen,
per the rule migrations 46-53 already obey: a migration generated from a live
mapping rewrites its own recorded SQL the next time a field is added, its
checksum changes, and every deployed database refuses the whole plan while a
fresh one stays green — it has already happened here. At thread scale the
index buys nothing worth that risk: a thread's artifacts are capped at 200
files and 100 MiB across all versions (artifacts.ts:49), and the search's
LIKE pre-filter scans only current bodies of one thread — bounded, and paid
only on a search call. The day artifacts outgrow the cap, migration 64 is
where the index goes, written out literally.

The same reasoning parks delta storage: every edit stores a whole body as a
new version, so ten one-line edits to a 500 KB file bank 5 MB against the
thread cap. Wire cost is solved by this spec; disk cost is not, and a delta
or content-addressed scheme needs its own design, its own migration, and a
compaction story.

## The failure table

Compile-time is the language refusing the implementation; run-time is the tool
or the database refusing the call, loudly, with nothing written; silent is a
green reply over an outcome nobody wanted. The silent column is the reason
this table exists — everything in it survived design, and each row names its
mitigation, not a fix.

| What goes wrong | Compile-time | Run-time | Silent |
|---|---|---|---|
| Record field named `new` for the wire's `new` | Reserved word: the compiler refuses the field. Fields are `oldText`/`newText`; scan.ts unpacking decouples wire from record | — | — |
| A new export colliding with an existing name | Duplicate binding in the flat namespace. Every export is `edit`- or `search`-prefixed | — | — |
| A failure path routed as a `throw` through a lambda | — | — | The fixpoint pass cannot see through a function value; a `try` above catches nothing and the process dies or continues wrongly. Avoided by construction: refusal values, straight-line calls, no throws below the dispatch |
| `old` matches nowhere — normalized whitespace, smart quotes, LF for CRLF | — | Refused; `editLoose` names a near-miss line when one exists, or says none does and points at search-and-copy | — |
| `old` matches more than once (counted overlapping) | — | Refused with numbered hits, lines and snippets; the model widens `old` from text it can see | — |
| `old` or `new` absent, misspelled, or non-string | — | Presence-checked with `jsonFind` before dispatch; refused naming the member. Without the check, `jsonText`'s `""` would flow onward | — |
| `old` empty, or `old == new` | — | Refused before any lookup: empty matches everywhere; a no-op burns a version row and lies that something changed | — |
| Unknown path, or a pointer naming a version the log lacks | — | Refused in read_artifact's own sentences; an edit never creates, a broken pointer is never an empty body | — |
| Spliced body over `ARTIFACT_MAX`, or thread over `THREAD_BYTES_MAX` | — | Refused inside the transaction, in `putArtifact`'s words, naming the cap so the model knows a retry will not help | — |
| Concurrent append lands N+1 first | — | Unique `(artifact_id, version)` fails the INSERT; retry re-reads and re-matches — merges when disjoint, refuses when the region moved | — |
| Arguments truncated mid-string by maxTokens | — | `jsonComplete` (scan.ts:273) rejects the call before dispatch, the TRUNCATED fixture's path | — |
| Search query with a pattern, a newline, or out of 2-200 bounds | — | Patterns match literally and find nothing; bounds and newline refused outright. "No hits" names how many artifacts were searched | — |
| `[cut]` marker copied into `old` | — | The marker is not in the body; the match fails. That is the marker's entire job | — |
| The visible prefix of a cut line used as `old`, and it happens to occur once | — | — | The worst row. The splice orphans the line's invisible tail mid-line and everything is green. Mitigated by the marker and the description's "never use a cut line as old"; a model that trims the marker itself is refused by nothing. The context echo is the after-the-fact tripwire |
| `old` unique but at the wrong one of two near-identical sites | — | — | One match exists; the tool has no access to intent. Made rare by refusal-on-ambiguity — a wrong-site edit requires constructing a unique-but-wrong `old` — and made visible by the context echo, which nothing forces the model to read. The append-only log is the recovery |
| `new` well-formed but wrong — a typo'd figure, a hallucinated value | — | — | No tool checks meaning; the previewToken (kept across versions, artifacts.ts:77) serves the wrong figure on every existing link immediately. The echo, the note, and the human version API are the recourse |
| Unicode normalization drift (NFC body, NFD `old`) | — | Each attempt is correctly refused | The failure mode is the fallback: repeated refusals push the model to `write_artifact`, and the full rewrite silently renormalizes every such character in the file, invisible in a skimmed diff. `editLoose` is blind to it and says so in this spec rather than in the refusal |
| Injected edit — a retrieved document tells the model to "correct" a file | — | — | House rule 5's case: path, `old` and `new` are model output that may be laundering an attacker. The call validates, versions and previews perfectly, and search hands an injected model discovery over files it never wrote. Defenses are structural only — append-only history, notes, the human API — and `wireView` on every quoted snippet keeps a poisoned body from using the refusal itself as a vector |
| Search miss read as absence — the model guessed the wrong case | — | — | The answer is truthful; the inference is wrong. A wrong belief, not a wrong write; the briefing line remains the corrective |

## Order of work

Each step lands alone, and each begins with the test that fails without it —
house rule 1: a fix with no test that failed beforehand is a claim. All
database tests run against SQLite temp files; nothing touches `:8100`,
`:5173`, or the live database.

1. **`editHits`, `editLineAt`** in artifacts-search.ts, pure functions first.
   Failing tests: `"aa"` in `"aaa"` answers two hits (overlap counting — the
   test that decides the uniqueness rule), a needle straddling a multi-byte
   character, needle at EOF, needle longer than body, CRLF bodies, the
   `most+1` early stop.
2. **`editLoose`.** Failing tests: tab-for-space drift found with its line;
   CRLF-vs-LF found; a genuinely absent needle answers -1; NFC/NFD drift
   answers -1 — the blindness is asserted, so a later "improvement" that
   half-sees unicode fails a test instead of shipping quietly.
3. **`searchSnippet`, `editContext`.** Failing tests: the 160-char cut lands
   on a UTF-8 boundary (argsPreview's walk-back), the ` [cut]` marker appears
   on cut lines and only there, context is exactly the changed lines plus two
   either side at both file edges.
4. **`editArtifact`**, the transaction. Failing tests: zero-match and
   multi-match refusals carry lines and snippets; the loose-match hint
   appears; empty `old`, `old == new`, missing path, broken pointer, and both
   byte caps refuse in the words this spec fixes; a successful edit leaves
   slot, title, kind, mime and previewToken byte-identical and bumps only
   `current_version` and `updated_at`.
5. **The race.** Failing test: an out-of-band INSERT of N+1 between the read
   and the edit's INSERT — disjoint change asserts a clean merge at N+2;
   a change inside the edited region asserts the changed-underneath refusal.
   This test is the spec's concurrency section, executable.
6. **`searchArtifacts`.** Failing tests: `%` and `_` in the query are found
   literally (the likeLiteral test), current-version-only, the 20/5 caps with
   `capped` set, `searched` counts artifacts not hits, path and title hits.
7. **Wiring** in tools.ts: the two ToolSpecs, the dispatch branches, the
   `jsonFind` presence checks, the synthesized note, `wireView` on every
   outbound snippet. Failing tests drive both tools end to end through
   `callArtifactTool`, including a misspelled member refused by name and a
   marker-bearing body quoted back neutralised.
8. **The words**: the briefing overflow line (artifacts.ts:692) now names
   search_artifacts, and the tools.ts:258 comment says why four. Failing
   test: the briefing for an over-cap thread contains "search_artifacts" and
   not "list with read_artifact".

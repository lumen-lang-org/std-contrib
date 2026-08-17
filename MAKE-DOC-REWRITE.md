# Rewriting `make-doc` (and its siblings)

> **EXECUTED 2026-08-02, commit `e638af5`.** make-doc/make-sheet/make-deck are
> CLI helpers in `agents-office:3`; briefings reseeded from
> `scenarios/office/seed_office_skills.py`; eval
> `scenarios/office/make_skills_eval.py` scores 3/3 on local qwen3-8b (was
> 0/3). The docxtpl lazy import already existed. One correction to the
> analysis below: the decisive cause was a **module-name mismatch** — the
> briefing said `from make_doc import build` while the staged file was
> `build_doc.py` — the same latent break existed in make-sheet and make-deck.
> Still open: `make-site` review; per-conversation office containers are a
> disk-hygiene item.

## What is actually broken

Asked for a one-page .docx on prod (local Qwen3-8B, 2026-08-02), the run went:

```
use_skill make-doc            ok
run_script                    FAIL  ImportError: from make_doc import build
run_script                    FAIL  same
run_script                    FAIL  same
write_artifact                ok    content: "<docx>...</docx>"
```

and the model answered *"The Word document has been created and saved as an
artifact."* The artifact existed at `/artifacts/docs/project-brief.docx`
version 1. Only opening it would ever have said otherwise.

Three causes, in the order they matter:

1. **The script ran in the wrong environment.** `run_script` was called with
   environment `"main"` → `agents-runtime:1`, which has **no office library**
   (verified: `docx`, `openpyxl`, `pptx`, `jinja2` all absent; it installs only
   `pillow cairosvg svgwrite requests`). Meanwhile `office.Dockerfile` — a
   separate image built FROM the same base — already has everything (below).
   The skill never told the model which environment to use.
2. **The skill names an API that does not exist.** `from make_doc import build`
   is the model's invention, but the body invited it by describing a capability
   instead of naming a command.
3. **The failure was silent.** Fixed in commit `1e6bb35`: `putAttempt` now
   refuses a `.docx`/`.xlsx`/`.pptx`/`.pdf` whose body is not that format
   (base64 of a ZIP starts `UEs`, a PDF `JVBER`). A failure now reaches the
   model as a tool result it can act on instead of reaching a person as a
   document. **A rerun today fails honestly rather than silently.**

## What already exists (checked, not assumed)

`office.Dockerfile` (`FROM agents-runtime:1`) is the real office environment and
is already complete:

- apt: **pandoc, zip/unzip, libreoffice-writer/calc/impress, poppler-utils**
- pip: **python-docx 1.1.2, openpyxl 3.1.5, python-pptx 1.0.2, docxtpl 0.20.0,
  lxml 5.3.0, pypdf 5.1.0**
- npm: **docx@9.1.1** (dolanmiu/docx, MIT), with `NODE_PATH` set
- copies `tools/office/` → `/opt/office/` and symlinks **`read-docx`,
  `fill-docx`, `merge-runs`** onto PATH

`tools/office/` is our own code: `read_docx.py` (pandoc → markdown),
`fill_docx.py` (docxtpl for jinja templates; our own XML run-merging path for
`<ANGLE>` placeholders), `merge_runs.py`. `office-render.ts` runs
`agents-office-render:2` per conversion, cached on `<artifactId>:<version>`.
`make-doc` / `make-sheet` / `make-deck` already exist as skill names in
`tools.ts:585` and `app/src/console.ts:66-68`.

**So the capability is present and the pattern is established. `make-doc` is
the one that was never wired to it.**

## Licensing — settled

- **Do not vendor Anthropic's skills.** `skills/docx/LICENSE.txt` is
  proprietary: forbids copying, derivatives, redistribution, commercial use.
- **Do not vendor `appautomaton/document-SKILLs`** (138★, claims MIT). Its tree
  mirrors Anthropic's proprietary layout and its own description says "adapted
  from Anthropic skills". An uploader cannot grant MIT over content they do not
  own — the MIT file is unenforceable as to the copied parts.
- `tfriedel/claude-office-skills` (800★) has **no LICENSE at all** → all rights
  reserved. The "awesome-*" repos are link indexes; their MIT covers the list,
  not the skills.
- **There is no openly-licensed office skill collection worth vendoring.** A
  skill body is markdown we author — writing our own is the only clean path and
  it is cheap.
- Libraries we rely on are clean: **python-docx MIT**, **python-pptx MIT**,
  **openpyxl MIT**, **XlsxWriter BSD-2**, **lxml BSD-3**, **pypdf BSD-3**.
- Copyleft present but at arm's length: **pandoc GPL-2.0** and **LibreOffice
  MPL-2.0/GPL-3.0** are invoked as subprocesses (mere aggregation, not
  linking) — keep them subprocess-only, never import or link. Shipping them in
  a distributed image still carries redistribution obligations.
- ⚠️ **`docxtpl` is LGPL-2.1-only** — the single copyleft item in our pip set.

## Recommendation: a fixed CLI helper, not model-written library code

**Add `tools/office/make_docx.py`, symlink it as `make-doc`, exactly like the
existing three.** The skill then tells the model one command.

Why this shape rather than "use python-docx":

- **An 8B model writing python-docx code will fail. An 8B model filling in a
  JSON spec and calling one command will not.** This is the decisive point, and
  it is the same thing that made `convert-currency` work this session: the body
  states a literal invocation, not a capability.
- Zero new dependencies — `office.Dockerfile` already has everything.
- Extends a pattern that already ships and is already on PATH.

Interface, kept deliberately dull:

```
make-doc spec.json out.docx
```

where `spec.json` is `{"title": "...", "blocks": [{"style":"h1","text":"..."}, …]}`
with styles `h1|h2|p|li`. The model writes a JSON file and runs one command —
no imports, no API surface to invent.

## The work

### 1. `tools/office/make_docx.py`

python-docx, ~60 lines: read spec, map `style` → `add_heading` /
`add_paragraph(style="List Bullet")`, `doc.save(out)`. Refuse an unknown style
loudly rather than silently dropping the block. Print the path written.

### 2. `office.Dockerfile`

One line in the existing symlink block: `ln -s /opt/office/make_docx.py
/usr/local/bin/make-doc`. Rebuild `agents-office-render:1`.

### 3. The `make-doc` skill body

Rewrite following the `convert-currency` shape that works on the 8B:

- **Line 1 is the rule the run hinges on:** *"run_script with environment
  `office` — not `main`. The document tools only exist there."*
- The literal two steps: write `spec.json` with a heredoc, then
  `make-doc spec.json brief.docx`.
- Declare the output in `paths` so the reconcile lands it as an artifact
  version. **The model must never base64 a document into `write_artifact`** —
  that produced the placeholder, and the engine now refuses it.
- **No sample output in the body.** A realistic-looking example got parroted
  instead of run — reproduced twice this session. Placeholders got the script
  run.

### 4. Verify it opens

The engine's guard proves the bytes are a ZIP; it does not prove Word opens
them. `soffice --headless --convert-to pdf` does, and it is already installed.

### 5. Then the siblings

`make-sheet` (openpyxl), `make-deck` (python-pptx) — same helper shape. Check
each existing body for an invented API and for a missing `environment: office`
before rewriting. `make-site` writes HTML; confirm rather than assume.

### 6. Legal cleanup while in `fill_docx.py`

Make **`docxtpl` a lazy/optional import**. It is the only copyleft item in the
pip set (LGPL-2.1-only). Our own comments say the `<ANGLE>` XML path — entirely
our code — is the one that matters on prod. Guarding the jinja path behind a
lazy import leaves the core dependency set 100% MIT/BSD with no obligations.

### 7. An eval that would have caught this

Every regression this session — the search `run_script` bug, fabricated FX
rates, the mangled card marker, the missing Search globe, this fake docx —
would have been caught by one committed scenario script with a scorer. For
documents the scorer is total and trivial: **fetch the artifact, base64-decode,
open with `zipfile`, assert `word/document.xml` is present.** A placeholder
fails instantly. Run it against both the local model and a hosted one.

## Model routing, decided by evidence

Measured this session on identical prompts:

| flow | Qwen3-8B (local) | Gemini Pro |
|---|---|---|
| currency card | works, ~9s | works, ~18s |
| web search | works (embellishes detail) | **refused to search**, answered from training data |
| doc tools | **fails** | untested since the fix |

The local model is not the problem across the board — it is faster on two of
three, and Gemini failed the search flow outright. Do not route everything
away from local. Re-measure documents after the rewrite and route only what
actually fails.

## Order

1. `make_docx.py` + symlink + image rebuild.
2. Rewrite the `make-doc` body. Test on the **local** model first — it is the
   harsher test and the current default.
3. LibreOffice-converts check.
4. Commit the eval scenario with the zipfile scorer.
5. Siblings, then the `docxtpl` lazy import.

## Do not

- Vendor Anthropic's skills, or `document-SKILLs` which relabels them.
- Put sample output in a skill body — reproducibly causes fabrication instead
  of execution.
- Let the model base64 a document into `write_artifact`.
- Adopt `office_oxide` yet (v0.1.8, five months old), or `odfpy` (GPL-2.0,
  abandoned 2020).
- Assume `main` and `office` are the same environment. That assumption is the
  whole bug.

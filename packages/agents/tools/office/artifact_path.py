"""Where a run's artifacts really are, for a caller that used the other path.

A conversation's artifacts have two names. The person and the model see the
artifact path — /docs/meeting-notes.docx — and a run materialises that file
under SCRIPT_RUN_DIR, at /artifacts/docs/meeting-notes.docx. Both names are
correct; only one of them opens.

Every briefing that got this wrong produced the same run: read-docx on the
artifact path, "does not exist", and a model telling the person their upload
is missing while the file sits one directory up. The briefings are fixed, but
a briefing is a sentence a model may paraphrase, so the helpers resolve it
too — one known, checked prefix, never a search.

Nothing is guessed silently: every rewrite prints what it did, so a run that
only worked because of this reads as having only worked because of this.
"""
from __future__ import annotations

import os
import sys

RUN_DIR = "/artifacts"


def resolve_input(path: str) -> str:
    """An existing file, preferring what the caller asked for."""
    if os.path.exists(path):
        return path
    if path.startswith("/") and not path.startswith(RUN_DIR + "/"):
        under = RUN_DIR + path
        if os.path.exists(under):
            print(f"note: {path} is the artifact path; reading {under}", file=sys.stderr)
            return under
    # Unchanged, so the error names the path the caller actually typed.
    return path


def resolve_output(path: str) -> str:
    """Where to write, so the run's reconcile will find it.

    A document written outside /artifacts is not saved anywhere the person
    can reach — the container is thrown away at the end of the run — and the
    script still prints "wrote", which is the failure that reads as success.
    """
    # A make-* output is always the deliverable, so a /tmp target is a
    # mistake: /tmp is scratch the reconcile throws away, and the older rule
    # below would bury it at RUN_DIR + the whole /tmp path — saving the deck
    # under a name nobody asked for, which is how one deck became two artifacts
    # (/night-run-club.pptx and /tmp/artifacts/night-run-club.pptx from one
    # run). Collapse a /tmp deliverable to its basename at the artifact root.
    if path.startswith("/tmp/") and os.path.isdir(RUN_DIR):
        at = RUN_DIR + "/" + os.path.basename(path)
        print(f"note: {path} is under /tmp and would be thrown away; writing {at}",
              file=sys.stderr)
        return at
    if path.startswith("/") and not path.startswith(RUN_DIR + "/") and os.path.isdir(RUN_DIR):
        under = RUN_DIR + path
        print(f"note: {path} is outside {RUN_DIR} and would not be saved; writing {under}",
              file=sys.stderr)
        return under
    return path

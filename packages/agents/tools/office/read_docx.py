#!/usr/bin/env python3
"""Read a document as markdown, so a model can see what it is editing.

pandoc, not a python binding: it is the reference implementation of what
OOXML means, and it keeps headings, lists and tables as structure rather than
flattening them into a wall of text. A model that reads the document first
stops inventing placeholder names — the failure this exists to prevent.

    python read_docx.py file.docx            # markdown to stdout
    python read_docx.py file.docx --holders  # just the <PLACEHOLDERS>
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_path import resolve_input  # noqa: E402


def markdown(path: Path) -> str:
    out = subprocess.run(
        ["pandoc", "-t", "markdown", "--wrap=none", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise SystemExit(f"pandoc failed: {out.stderr.strip()[:300]}")
    return out.stdout


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    # Flags anywhere: the file is the first argument that is not a flag.
    holders = "--holders" in argv
    rest = [a for a in argv[1:] if not a.startswith("-")]
    if not rest:
        print(__doc__)
        return 2
    path = Path(resolve_input(rest[0]))
    text = markdown(path)
    if holders:
        # pandoc escapes markdown punctuation and rewrites typography — a
        # placeholder comes back as "<name --- role\\>". Undo both, or the
        # names printed here do not match the ones in the document and a
        # caller fills nothing.
        plain = text.replace("\\", "").replace("---", "\u2014").replace("--", "\u2013")
        found = sorted(set(re.findall(r"<[A-Za-z][^<>]{0,60}>", plain)))
        print(json.dumps({"file": str(path), "placeholders": found}, ensure_ascii=False))
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

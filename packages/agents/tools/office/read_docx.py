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
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_path import resolve_input  # noqa: E402

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def markdown(path: Path) -> str:
    out = subprocess.run(
        ["pandoc", "-t", "markdown", "--wrap=none", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise SystemExit(f"pandoc failed: {out.stderr.strip()[:300]}")
    return out.stdout


def paragraph_texts(path: Path) -> list[str]:
    """Every paragraph's own text, straight from the XML.

    Not pandoc: a paragraph whose entire text is one bracketed word — which
    is exactly what a Title-styled placeholder is — can reach pandoc's
    markdown writer as raw HTML it does not recognise, and vanish from the
    rendered output rather than surviving as text. This reads a placeholder's
    own words from the one place they cannot be reinterpreted: every <w:t>
    run inside a <w:p>, joined in document order, so a run Word split
    mid-word (its own spell-check markers do this) still joins back into one
    piece.
    """
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    out: list[str] = []
    for p in root.iter(f"{W}p"):
        joined = "".join(t.text or "" for t in p.iter(f"{W}t"))
        if joined.strip():
            out.append(joined)
    return out


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
    if holders:
        found: set[str] = set()
        for para in paragraph_texts(path):
            found.update(re.findall(r"<[A-Za-z][^<>]{0,60}>", para))
        print(json.dumps({"file": str(path), "placeholders": sorted(found)}, ensure_ascii=False))
        return 0
    print(markdown(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

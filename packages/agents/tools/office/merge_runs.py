#!/usr/bin/env python3
"""Coalesce Word's fragmented text runs so the text can be found at all.

Word splits a sentence across many <w:r> elements for reasons that have
nothing to do with how it looks: a revision id, a spell-check marker, a
proofing-language switch mid-word. So "<MEETING>" in a document is routinely
three runs, `<`, `MEETING`, `>`, and every find-and-replace that walks runs
one at a time finds nothing — which is how a model comes to tell somebody
their template is missing a placeholder that is plainly on the page.

This merges ADJACENT runs whose formatting is identical, in place, without
changing a single visible thing: same text, same properties, same order. It
is the step that makes an OOXML edit possible, and it is why editing a .docx
starts with unzip rather than with a library.

    python merge_runs.py unpacked/            # a directory from unzip
    python merge_runs.py file.docx --inplace  # or the .docx itself

Written here rather than taken from anywhere: the technique is public and
mechanical, the implementation is ours.
"""
from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def _props(run: etree._Element) -> str:
    """A run's formatting, as a comparable string. Two runs merge only when
    this matches exactly — merging across a bold boundary would change the
    document, which this is not allowed to do."""
    rpr = run.find(f"{{{W}}}rPr")
    if rpr is None:
        return ""
    return etree.tostring(rpr, method="c14n2" if hasattr(etree, "c14n2") else "c14n").decode()


def _mergeable(run: etree._Element) -> bool:
    """A run of plain text only. Anything carrying a break, a drawing, a
    footnote reference or a field is left exactly where it is."""
    for child in run:
        tag = etree.QName(child).localname
        if tag not in ("rPr", "t"):
            return False
    return run.find(f"{{{W}}}t") is not None


def merge_document(xml: bytes) -> tuple[bytes, int]:
    root = etree.fromstring(xml)
    merged = 0
    for para in root.iter(f"{{{W}}}p"):
        prev = None
        for run in list(para.findall(f"{{{W}}}r")):
            if prev is None or not (_mergeable(prev) and _mergeable(run)) or _props(prev) != _props(run):
                prev = run
                continue
            a = prev.find(f"{{{W}}}t")
            b = run.find(f"{{{W}}}t")
            a.text = (a.text or "") + (b.text or "")
            # xml:space=preserve, or Word eats the spaces the join created.
            a.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            para.remove(run)
            merged += 1
    # No pretty-printing, ever: Word treats added whitespace between runs as
    # content, and a reformatted document.xml comes back with spaces nobody
    # typed.
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), merged


def merge_dir(unpacked: Path) -> int:
    doc = unpacked / "word" / "document.xml"
    if not doc.exists():
        raise SystemExit(f"{doc} does not exist — is this an unpacked .docx?")
    out, n = merge_document(doc.read_bytes())
    doc.write_bytes(out)
    return n


def merge_docx(path: Path) -> int:
    tmp = path.with_suffix(".merging")
    total = 0
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                data, total = merge_document(data)
            zout.writestr(item, data)
    shutil.move(tmp, path)
    return total


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    target = Path(argv[1])
    if target.is_dir():
        print(f"merged {merge_dir(target)} runs in {target}/word/document.xml")
    else:
        print(f"merged {merge_docx(target)} runs in {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

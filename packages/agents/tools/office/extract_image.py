#!/usr/bin/env python3
"""Turn a page of a document into an image the reader sees in the chat.

    extract-image file.pdf 2 /artifacts/images/page-2.png     # page 2 of a pdf
    extract-image report.docx 1 /artifacts/images/cover.png   # any office doc
    extract-image report.docx --embedded /artifacts/images/   # its pictures

A .png artifact renders as a picture in the conversation, so this is how a
"show me the chart on page 3" gets answered with the chart rather than a
description of it. Office documents go through LibreOffice to PDF first —
already in this image — and pdftoppm rasterises the page at 150dpi, which
reads clearly in a chat column without shipping a poster.

--embedded pulls the pictures OUT of an office file instead (they are files
in the zip): each lands beside the others in the output directory, named as
the document names them. Use it when the person wants the photo itself, not
the page it sits on.

A fixed command, like make-doc and fill-docx beside it: a model writing
pdf-rendering code from memory invents libraries; a model running one
command does not.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_path import resolve_input, resolve_output  # noqa: E402

OFFICE = (".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp")


def to_pdf(src: Path) -> Path:
    out_dir = Path("/tmp/extract-image")
    out_dir.mkdir(exist_ok=True)
    run = subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(src)],
        capture_output=True, text=True, timeout=180)
    made = out_dir / (src.stem + ".pdf")
    if not made.exists():
        raise SystemExit(f"LibreOffice could not convert {src.name}: {run.stderr.strip()[:200]}")
    return made


def page_to_png(pdf: Path, page: int, out: Path) -> None:
    parent = os.path.dirname(str(out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    # pdftoppm writes <prefix>-<n>.png; a single page keeps it predictable.
    prefix = str(out.with_suffix(""))
    run = subprocess.run(
        ["pdftoppm", "-png", "-r", "150", "-f", str(page), "-l", str(page), str(pdf), prefix],
        capture_output=True, text=True, timeout=120)
    made = sorted(Path(parent or ".").glob(Path(prefix).name + "*.png"))
    if not made:
        raise SystemExit(f"no page {page} in {pdf.name}: {run.stderr.strip()[:200]}"
                         " — pages are counted from 1")
    shutil.move(str(made[0]), str(out))
    print(f"wrote {out}")


def embedded(src: Path, out_dir: Path) -> None:
    os.makedirs(str(out_dir), exist_ok=True)
    wrote = 0
    with zipfile.ZipFile(src) as z:
        for name in z.namelist():
            base = name.lower()
            if "/media/" in base and base.endswith((".png", ".jpg", ".jpeg", ".gif")):
                target = out_dir / Path(name).name
                target.write_bytes(z.read(name))
                print(f"wrote {target}")
                wrote += 1
    if wrote == 0:
        raise SystemExit(f"{src.name} embeds no pictures — its pages can still be"
                         " rendered: extract-image FILE PAGE OUT.png")


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    src = Path(resolve_input(argv[1]))
    if not src.exists():
        raise SystemExit(f"{argv[1]}: no such file — name it in run_script's paths so the run materialises it")

    if argv[2] == "--embedded":
        if len(argv) < 4:
            raise SystemExit("--embedded needs an output directory under /artifacts/images/")
        if src.suffix.lower() not in OFFICE:
            raise SystemExit(f"{src.name} is not an office file — --embedded reads the pictures out of a docx/xlsx/pptx zip")
        embedded(src, Path(resolve_output(argv[3])))
        return 0

    try:
        page = int(argv[2])
    except ValueError:
        raise SystemExit(f"{argv[2]!r} is not a page number — pages are counted from 1")
    if len(argv) < 4:
        raise SystemExit("name the output: extract-image FILE PAGE /artifacts/images/NAME.png")
    out = Path(resolve_output(argv[3]))
    pdf = src if src.suffix.lower() == ".pdf" else to_pdf(src)
    page_to_png(pdf, page, out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

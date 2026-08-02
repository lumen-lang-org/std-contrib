#!/usr/bin/env python3
"""Build a presentation from a JSON spec. No API to learn, one command:

    make-deck spec.json out.pptx

spec.json:

    {"title": "The deck title",
     "subtitle": "",
     "slides": [
       {"title": "Problem", "bullets": ["First point", "Second"], "notes": ""}
     ]}

One idea per slide, at most five bullets — a slide is a prompt for a
speaker, not a page of prose. notes lands in the speaker notes.

This exists because a model writing python-pptx code from memory invents
imports and APIs; a model filling in this spec and running one command does
not. The spec is the whole surface.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def build(spec: dict, out: Path) -> int:
    from pptx import Presentation
    from pptx.util import Pt

    slides = spec.get("slides")
    if not isinstance(slides, list) or not slides:
        raise SystemExit('spec has no "slides": expected a non-empty list of {"title","bullets"}')
    deck = Presentation()
    first = deck.slides.add_slide(deck.slide_layouts[0])
    first.shapes.title.text = str(spec.get("title", "Untitled"))
    if spec.get("subtitle") and len(first.placeholders) > 1:
        first.placeholders[1].text = str(spec["subtitle"])
    for i, s in enumerate(slides):
        if not isinstance(s, dict):
            raise SystemExit(f'slides[{i}] is not an object')
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = str(s.get("title", ""))
        body = slide.placeholders[1].text_frame
        for j, b in enumerate(s.get("bullets", [])):
            para = body.paragraphs[0] if j == 0 else body.add_paragraph()
            para.text = str(b)
            para.font.size = Pt(20)
        if s.get("notes"):
            slide.notes_slide.notes_text_frame.text = str(s["notes"])
    parent = os.path.dirname(str(out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    deck.save(str(out))
    print(f"wrote {out} ({len(slides)} slides)")
    return 0


def main(argv: list[str]) -> int:
    # See make_docx.py: the one real cause of a wrong count is an unquoted
    # space in the output path, so the error says that instead of the usage.
    if len(argv) > 3:
        raise SystemExit(
            f"got {len(argv) - 1} arguments, expected 2: make-deck spec.json out.pptx —"
            " a path with a space must be quoted; better, name the file with dashes,"
            " like /artifacts/decks/q3-review.pptx"
        )
    if len(argv) < 3:
        print(__doc__)
        return 2
    spec_path, out = Path(argv[1]), Path(argv[2])
    try:
        spec = json.loads(spec_path.read_text("utf8"))
    except FileNotFoundError:
        raise SystemExit(f"{spec_path}: no such file — write the spec first, then run make-deck")
    except json.JSONDecodeError as e:
        raise SystemExit(f"{spec_path} is not valid JSON: {e}")
    if not isinstance(spec, dict):
        raise SystemExit(f"{spec_path}: expected a JSON object, got {type(spec).__name__}")
    return build(spec, out)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

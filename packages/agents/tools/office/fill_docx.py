"""Fill a Word document by replacing its placeholders, whatever Word did to them.

Two paths, chosen by what the template actually contains:

  jinja  a template written with {{ name }} / {% for %} tags is handed to
         docxtpl, which is the right tool: Word owns every style and the
         script supplies only values, so nothing about the look passes
         through python.

  angle  a template written with <PLACEHOLDER> — which is what this
         deployment's own templates use — is edited at the XML level, after
         merging runs, so a placeholder split across three runs by Word's
         revision tracking is still found.

The second path is the one that matters here, because the first failure on
prod was exactly this: python-docx walked paragraph.runs, saw "<", "MEETING",
">" as three separate texts, matched nothing, and the model announced that
the template was missing a placeholder that was plainly on the page.

    python fill_docx.py in.docx out.docx '{"<MEETING>": "Kick-off"}'
    python fill_docx.py in.docx out.docx fills.json

Unfilled placeholders are LEFT VISIBLE. An unanswered <WHO CALLED IT> should
look unanswered; a blank line reads as an answered question.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_runs import merge_document  # noqa: E402

# Every part a placeholder can hide in. A meeting template puts <DATE> in the
# body and <FOOTER> in a footer, and a fill that only touched document.xml
# would report success having missed half the document.
PARTS = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
JINJA = re.compile(r"\{\{.*?\}\}|\{%.*?%\}", re.S)


def _looks_jinja(path: Path) -> bool:
    with zipfile.ZipFile(path) as z:
        try:
            return bool(JINJA.search(z.read("word/document.xml").decode("utf8", "ignore")))
        except KeyError:
            return False


def fill_jinja(src: Path, dst: Path, fills: dict) -> dict:
    from docxtpl import DocxTemplate
    doc = DocxTemplate(str(src))
    # Keys arrive as {{ name }} or name; docxtpl wants the bare name.
    context = {re.sub(r"[{}%\s]", "", k): v for k, v in fills.items()}
    doc.render(context)
    doc.save(str(dst))
    return {"how": "jinja", "filled": sorted(context), "left": []}


def fill_angle(src: Path, dst: Path, fills: dict) -> dict:
    hit: dict[str, int] = {k: 0 for k in fills}
    tmp = dst.with_suffix(".building")
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if PARTS.match(item.filename):
                # Merge first — this is the whole reason the naive path fails.
                data, _ = merge_document(data)
                text = data.decode("utf8")
                for key, value in fills.items():
                    # The KEY has to be escaped too, and this is the whole
                    # trick: inside document.xml a placeholder written
                    # <MEETING> is stored as &lt;MEETING&gt;, because "<" is
                    # markup. Searching for the literal finds nothing, on a
                    # document that plainly contains it — which is exactly
                    # the lie the old fill told.
                    for needle in (esc(key), key):
                        if needle in text:
                            hit[key] += text.count(needle)
                            text = text.replace(needle, esc(str(value)))
                            break
                data = text.encode("utf8")
            zout.writestr(item, data)
    shutil.move(tmp, dst)
    return {
        "how": "angle",
        "filled": {k: n for k, n in hit.items() if n},
        "left": [k for k, n in hit.items() if not n],
    }


def esc(text: str) -> str:
    """XML text, as document.xml stores it."""
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def remaining(path: Path) -> list[str]:
    """Placeholders still in the document — what the person will see. The
    honest end of a fill: it says what it did NOT do."""
    out: set[str] = set()
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if PARTS.match(name):
                merged, _ = merge_document(z.read(name))
                xml = merged.decode("utf8")
                # Strip the MARKUP, then unescape — in that order. Doing it
                # the other way round turns every &lt;NAME&gt; into a tag and
                # the strip eats the very thing being looked for, which is
                # how this reported an empty document as fully filled.
                body = re.sub(r"<[^>]+>", "", xml)
                body = (body.replace("&lt;", "<").replace("&gt;", ">")
                        .replace("&amp;", "&"))
                out.update(re.findall(r"<[A-Za-z][^<>]{0,60}>", body))
    return sorted(out)


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__)
        return 2
    src, dst, spec = Path(argv[1]), Path(argv[2]), argv[3]
    fills = json.loads(Path(spec).read_text()) if Path(spec).exists() else json.loads(spec)
    result = fill_jinja(src, dst, fills) if _looks_jinja(src) else fill_angle(src, dst, fills)
    result["still_unfilled"] = remaining(dst)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

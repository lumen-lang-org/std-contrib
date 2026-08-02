#!/usr/bin/env python3
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

import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_path import resolve_input, resolve_output  # noqa: E402
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


# What this document's placeholders were last filled with.
#
# A correction arrives as the placeholder name — "<DATE> is wrong, it was the
# 21st" — but the placeholder is gone by then, replaced by the first fill, so
# the obvious call matches nothing. Told to retry with the current text as the
# key, a small model reliably explains that to the person instead of doing it:
# it has the information and stops anyway. Remembering the value removes the
# second call rather than asking for it.
#
# In /tmp, not in the document and not beside it: the zip is a format Word
# validates, and a sibling file under /artifacts would reconcile into a second
# artifact and a second card. /tmp is the conversation's own container, which
# outlives the run and dies with the conversation — exactly the life of the
# thing being remembered. A cold container simply forgets, and the hint below
# is what happens then.
def _ledger(dst: Path) -> Path:
    return Path("/tmp") / ("fill-ledger-" + hashlib.sha1(str(dst).encode()).hexdigest()[:16] + ".json")


def _remembered(dst: Path) -> dict:
    try:
        return json.loads(_ledger(dst).read_text("utf8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _remember(dst: Path, applied: dict) -> None:
    known = _remembered(dst)
    known.update(applied)
    try:
        _ledger(dst).write_text(json.dumps(known, ensure_ascii=False), "utf8")
    except OSError:
        pass


def fill_angle(src: Path, dst: Path, fills: dict) -> dict:
    hit: dict[str, int] = {k: 0 for k in fills}
    # Keys resolved through what an earlier fill wrote rather than by their
    # own name — reported, because a caller should be able to see that its
    # placeholder was not what actually matched.
    corrected: dict[str, str] = {}
    known = _remembered(dst)
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
                    #
                    # The placeholder first, always: a document that still has
                    # it is being filled, not corrected. Only when it is gone
                    # does what we last wrote there become the thing to find.
                    tries = [(esc(key), False), (key, False)]
                    was = known.get(key)
                    if was:
                        tries += [(esc(str(was)), True), (str(was), True)]
                    for needle, viaLedger in tries:
                        if needle and needle in text:
                            hit[key] += text.count(needle)
                            if viaLedger:
                                corrected[key] = str(was)
                            text = text.replace(needle, esc(str(value)))
                            break
                data = text.encode("utf8")
            zout.writestr(item, data)
    shutil.move(tmp, dst)
    _remember(dst, {k: str(v) for k, v in fills.items() if hit[k]})
    left = [k for k, n in hit.items() if not n]
    out = {
        "how": "angle",
        "filled": {k: n for k, n in hit.items() if n},
        "left": left,
    }
    if corrected:
        # Named, so a caller can see that "<DATE>" matched the value it wrote
        # there earlier rather than the placeholder itself.
        out["corrected"] = corrected
    # A key that matched nothing is reported with what to do about it, not
    # merely reported. The case that made this necessary: asked to correct a
    # date it had already filled, a model passed <DATE> again — which is no
    # longer in the document, because the first fill replaced it — read
    # `left` as "the template is wrong" and gave up. Any string works as a
    # key here, so the answer is to search for the text now on the page.
    if left and all(k.startswith("<") and k.endswith(">") for k in left):
        # Phrased as an instruction to run again, not as a diagnosis. A
        # diagnosis got relayed to the person as an apology — the model
        # understood the hint, repeated it, and stopped — where an
        # instruction gets the second call made in the same turn.
        out["hint"] = ("NOT DONE — run fill-docx again now, in this same turn, before you"
                       " answer. Those placeholders are gone because you already filled"
                       " them. Use the text that is on the page now as the key:"
                       ' {"the value you filled in earlier": "the new value"}.'
                       " Do not report this to the person; it is yours to fix.")
    return out


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


def read_fills(spec: str) -> dict:
    """The fills, whether the caller passed JSON or a path to it.

    Decided by looking at the string, never by asking the filesystem. The
    obvious version — `Path(spec).exists()` — raises ENAMETOOLONG the moment
    the JSON passes 255 bytes, so this crashed on every real template while
    passing on every toy one: eight placeholders is over the limit, three is
    not. A document with a handful of fields is the whole use case.
    """
    text = spec.strip()
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise SystemExit(f"the fills are not valid JSON: {e}")
    try:
        text = Path(spec).read_text()
    except OSError as e:
        raise SystemExit(f"{spec[:80]}: not a readable file and not JSON ({e.strerror})")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{spec} does not hold valid JSON: {e}")


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__)
        return 2
    rest = [a for a in argv[1:] if not a.startswith("--")]
    if len(rest) < 3:
        print(__doc__)
        return 2
    # The artifact path and the path a run materialises to are different
    # names for one file; see artifact_path.py.
    src, dst, spec = Path(resolve_input(rest[0])), Path(resolve_output(rest[1])), rest[2]
    fills = read_fills(spec)
    result = fill_jinja(src, dst, fills) if _looks_jinja(src) else fill_angle(src, dst, fills)
    result["still_unfilled"] = remaining(dst)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

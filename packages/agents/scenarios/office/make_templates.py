# Build the real office templates the capability pages start from.
#
# A template is a document, not a prompt: styled headings, tables that already
# have their columns, slide layouts already chosen. The agent opens it and
# fills it in, which is a different job from writing one from nothing — and
# the reason a person picks a template at all.
#
# Placeholders are <ANGLED> so they are findable by the editor skill and
# obviously unfinished to a reader who opens the file before the agent does.
import os
from docx import Document
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from pptx import Presentation
from pptx.util import Pt as PPt

OUT = os.path.dirname(os.path.abspath(__file__))

def status_report():
    d = Document()
    d.add_heading("<TITLE>", level=0)
    p = d.add_paragraph("<PERIOD> · <AUTHOR>")
    p.runs[0].font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    for heading, body in [
        ("Context", "<one paragraph: what the reader needs before the detail>"),
        ("What happened", None),
        ("What is next", None),
        ("Decisions waiting", None),
    ]:
        d.add_heading(heading, level=1)
        if body:
            d.add_paragraph(body)
        else:
            for _ in range(3):
                d.add_paragraph("<item>", style="List Bullet")
    d.add_heading("Numbers", level=1)
    t = d.add_table(rows=3, cols=3)
    t.style = "Light Grid Accent 1"
    for i, h in enumerate(["Measure", "This period", "Last period"]):
        cell = t.cell(0, i)
        cell.text = h
        cell.paragraphs[0].runs[0].font.bold = True
    for r in range(1, 3):
        for c in range(3):
            t.cell(r, c).text = "<value>"
    d.save(os.path.join(OUT, "status-report.docx"))

def budget_tracker():
    wb = Workbook()
    ws = wb.active
    ws.title = "Budget"
    head = ["Item", "Planned", "Actual", "Variance"]
    ws.append(head)
    fill = PatternFill("solid", fgColor="EEEEEE")
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = fill
    for r in range(2, 12):
        ws.cell(r, 1, "<item>")
        ws.cell(r, 2, 0)
        ws.cell(r, 3, 0)
        # The variance column is a formula, which is the point of shipping a
        # real workbook: the agent fills items and numbers, the sheet does the
        # arithmetic and keeps doing it after the reader edits a cell.
        ws.cell(r, 4, f"=C{r}-B{r}")
    ws.cell(12, 1, "Total").font = Font(bold=True)
    for col in "BCD":
        ws[f"{col}12"] = f"=SUM({col}2:{col}11)"
        ws[f"{col}12"].font = Font(bold=True)
    for i, w in enumerate([34, 14, 14, 14], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    wb.save(os.path.join(OUT, "budget-tracker.xlsx"))

def pitch_deck():
    deck = Presentation()
    title = deck.slides.add_slide(deck.slide_layouts[0])
    title.shapes.title.text = "<COMPANY>"
    title.placeholders[1].text = "<the one sentence>"
    for name, hint in [
        ("Problem", "<whose, how often, what it costs them today>"),
        ("Insight", "<what you know that the room does not>"),
        ("What we built", "<the thing, not the roadmap>"),
        ("Why it wins", "<the moat, the wedge, or the unfair advantage>"),
        ("The ask", "<amount, hire, decision — be specific>"),
    ]:
        s = deck.slides.add_slide(deck.slide_layouts[1])
        s.shapes.title.text = name
        tf = s.placeholders[1].text_frame
        tf.paragraphs[0].text = hint
        tf.paragraphs[0].font.size = PPt(20)
        for _ in range(2):
            para = tf.add_paragraph()
            para.text = "<point>"
            para.font.size = PPt(20)
        s.notes_slide.notes_text_frame.text = "<what the speaker says here>"
    deck.save(os.path.join(OUT, "pitch-deck.pptx"))

status_report(); budget_tracker(); pitch_deck()
print("built:", sorted(f for f in os.listdir(OUT) if f.split('.')[-1] in ('docx','xlsx','pptx')))

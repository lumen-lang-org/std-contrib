import { Db } from "../plume/driver.ts";
import { persist, findById } from "../plume/plume.ts";
import { SkillRow, skillsMapping } from "./schema.ts";
import { stamp } from "./api-core.ts";

export const OFFICE_SKILL_IDS: string[] = [
  "skill-fill-doc",
  "skill-read-doc",
  "skill-make-doc",
  "skill-make-sheet",
  "skill-make-deck",
];

const FILL_DOC_BODY: string = `Fill a .docx template by replacing its placeholders. The template keeps its
own styling: you supply values only, and Word owns the look.

    fill-docx template.docx out.docx fills.json

fills.json maps each placeholder to its value, and the key is the placeholder
exactly as it appears in the document, brackets included:

    {"<CLIENT>": "Acme Corp", "<DATE>": "3 March 2026", "<TOTAL>": "48,000"}

Writing the bare name instead — "CLIENT" rather than "<CLIENT>" — replaces
only the word inside the brackets and leaves them behind, so the document
comes out reading "<Acme Corp>". The tool notices and says so in
still_unfilled; if you see your own values listed there, this is why.

A jinja template written with {{ client }} tags is handed to docxtpl instead,
and there the key is the bare name. The tool picks the path by what the
template contains, so read it first.

Read the template with read-doc before filling it, to learn the real
placeholder names rather than guessing: a key that is not in the template is
reported in left and nothing is written for it.

A placeholder Word split across several runs is still found — runs are merged
before matching — so a template that looks right in Word fills even when its
XML is fragmented.

These commands live in the conversation's environment, so the way to use them
is to hand the job to delegate_to_joule_code and say in the brief which command
to run and what the result must be. The agent there can run it, look at what
came out, and fix it — which is what document work needs, because a template
that filled wrongly looks fine to a script and obvious to a reader.`;

const READ_DOC_BODY: string = `Print what a Word document actually contains — every paragraph with its
style, and its tables — so you can see the structure before you change it.

    read-docx report.docx

Use it before fill-doc, to learn the real placeholder names, and before any
edit, to see which styles the document uses so a change keeps them. It reads;
it never writes.

These commands live in the conversation's environment, so the way to use them
is to hand the job to delegate_to_joule_code and say in the brief which command
to run and what the result must be. The agent there can run it, look at what
came out, and fix it — which is what document work needs, because a template
that filled wrongly looks fine to a script and obvious to a reader.`;

const MAKE_DOC_BODY: string = `Build a .docx from markdown. One command, and Word's own styles come out:

    make-doc brief.md out.docx

    # Project Brief      -> the document title
    ## Background        -> a section heading
    ### Detail           -> a sub-heading
    One paragraph.       -> a paragraph
    - A bullet.          -> a bullet

Nothing needs quoting or escaping. Use this to produce a document from
scratch; use fill-doc when a template already exists, because a template
carries styling this cannot reproduce.

These commands live in the conversation's environment, so the way to use them
is to hand the job to delegate_to_joule_code and say in the brief which command
to run and what the result must be. The agent there can run it, look at what
came out, and fix it — which is what document work needs, because a template
that filled wrongly looks fine to a script and obvious to a reader.`;

const MAKE_SHEET_BODY: string = `Build a real .xlsx spreadsheet:

    make-sheet data.json out.xlsx

The result is a genuine workbook with typed cells, not a CSV with a different
extension, so formulas and number formats survive being opened in Excel.

These commands live in the conversation's environment, so the way to use them
is to hand the job to delegate_to_joule_code and say in the brief which command
to run and what the result must be. The agent there can run it, look at what
came out, and fix it — which is what document work needs, because a template
that filled wrongly looks fine to a script and obvious to a reader.`;

const MAKE_DECK_BODY: string = `Build a real .pptx deck:

    make-deck slides.json out.pptx

One slide per entry, with the layout PowerPoint expects, so the file opens
and edits like a deck somebody made by hand.

These commands live in the conversation's environment, so the way to use them
is to hand the job to delegate_to_joule_code and say in the brief which command
to run and what the result must be. The agent there can run it, look at what
came out, and fix it — which is what document work needs, because a template
that filled wrongly looks fine to a script and obvious to a reader.`;

type OfficeSkillSeed = {
  id: string,
  skillName: string,
  description: string,
  body: string,
};

function officeSkillSeeds(): OfficeSkillSeed[] {
  return [
    { id: "skill-fill-doc", skillName: "fill-doc", description: "Fill a Word template's placeholders and save it as a new document, keeping the template's own styling.", body: FILL_DOC_BODY },
    { id: "skill-read-doc", skillName: "read-doc", description: "Read a .docx and print its paragraphs, styles and tables, so you can see what is in it before changing it.", body: READ_DOC_BODY },
    { id: "skill-make-doc", skillName: "make-doc", description: "Write a new Word document from markdown, with real headings, paragraphs and bullets.", body: MAKE_DOC_BODY },
    { id: "skill-make-sheet", skillName: "make-sheet", description: "Write a .xlsx spreadsheet from a simple spec, with real cells rather than a CSV renamed.", body: MAKE_SHEET_BODY },
    { id: "skill-make-deck", skillName: "make-deck", description: "Write a .pptx deck from a simple spec, one slide per entry.", body: MAKE_DECK_BODY },
  ];
}

export function seedOfficeSkills(db: Db): void {
  let now = stamp();
  let seeds = officeSkillSeeds();
  let i: int = 0;
  while (i < seeds.length) {
    let s = seeds[i];
    if (findById(db, skillsMapping(), s.id) == "") {
      let row: SkillRow = {
        id: s.id,
        skillName: s.skillName,
        description: s.description,
        body: s.body,
        updatedAt: now,
        visibility: "public",
        featuredRank: 0,
        source: "local",
        sourceUrl: "",
      };
      persist(db, skillsMapping(), JSON.stringify(row));
    }
    i = i + 1;
  }
}

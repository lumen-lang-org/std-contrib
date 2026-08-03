# The environment the office skills run in — make-doc, make-sheet, make-deck.
#
# Its own image rather than more weight in agents-runtime:1, because the
# document stack is the heaviest thing any skill asks for and most
# conversations never touch it. A conversation pays for this image the first
# time a run asks for it and not before.
#
# Versions pinned, and the pin is the contract: a skill's briefing documents
# builder behaviour, and a silent library bump that changes output formatting
# would make the briefing lie. Bump the pins and the briefings together.
#
# --- why this image grew ---------------------------------------------------
#
# python-docx alone loses the argument with a real document. Word splits a
# sentence across many <w:r> runs — revision ids, spell-check markers, a
# language switch mid-word — so "<MEETING>" is routinely three runs, and any
# find-and-replace that works run-by-run finds nothing. A model that gets
# "not found" from a document whose text is plainly on the page then tells
# the person their template is broken. That was the failure on prod.
#
# The industry answer, which Anthropic's published docx skill also describes,
# is not a library at all — it is a technique:
#
#   read   pandoc, which understands OOXML properly
#   fill   a template engine that keeps Word's own styling (docxtpl)
#   edit   unzip -> coalesce runs -> edit word/document.xml -> zip
#   check  render with LibreOffice and look at the result
#
# So this image carries what each of those needs. The scripts implementing
# them are OURS (tools/office/, staged into every skill that ships them);
# Anthropic's skill files are proprietary and are not copied here.
FROM agents-runtime:1

# pandoc reads .docx to markdown better than any python binding — it is the
# reference implementation of the format's semantics. LibreOffice renders the
# result so a run can look at what it produced instead of trusting itself.
# zip/unzip are the edit path: a .docx IS a zip, and the whole point of
# editing at the XML level is not to round-trip it through a library.
RUN apt-get update && apt-get install -y --no-install-recommends \
      pandoc \
      zip unzip \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# docxtpl turns a .docx into a jinja2 template: Word owns the styling, the
# script supplies only values, and nothing about the document's look passes
# through python. lxml is the OOXML editing path's only requirement.
RUN pip install --no-cache-dir \
    python-docx==1.1.2 \
    openpyxl==3.1.5 \
    python-pptx==1.0.2 \
    docxtpl==0.20.0 \
    lxml==5.3.0 \
    pypdf==5.1.0

# The helpers, at a fixed path every run can rely on.
#
# In the image and not only as skill files, because a model reaches for the
# environment before it reaches for a skill: it sees "office" in the system
# prompt with a summary saying these exist, and can call them without loading
# anything. Twice on prod a model asked to fill a template wrote its own
# python-docx script instead — it had no idea a working one was already here.
COPY tools/office/ /opt/office/
# Executable, and every path a model might type. A run that answers
# "Permission denied" for a helper the environment advertises is worse than
# not advertising it — the model spends the round chmod-ing.
RUN chmod +x /opt/office/*.py \
 && ln -sf /opt/office/read_docx.py /usr/local/bin/read-docx \
 && ln -sf /opt/office/fill_docx.py /usr/local/bin/fill-docx \
 && ln -sf /opt/office/merge_runs.py /usr/local/bin/merge-runs \
 && ln -sf /opt/office/make_docx.py /usr/local/bin/make-doc \
 && ln -sf /opt/office/make_xlsx.py /usr/local/bin/make-sheet \
 && ln -sf /opt/office/make_pptx.py /usr/local/bin/make-deck \
 && ln -sf /opt/office/extract_image.py /usr/local/bin/extract-image

# The docx npm library, for BUILDING a document from nothing — it produces
# cleaner OOXML than python-docx and is what the published guidance uses. A
# global install so a script can require() it without a package.json.
RUN npm install -g docx@9.1.1 && npm cache clean --force
ENV NODE_PATH=/usr/lib/node_modules

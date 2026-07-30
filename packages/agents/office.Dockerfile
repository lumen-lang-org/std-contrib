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
FROM agents-runtime:1
RUN pip install --no-cache-dir \
    python-docx==1.1.2 \
    openpyxl==3.1.5 \
    python-pptx==1.0.2

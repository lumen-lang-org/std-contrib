# One image for everything a conversation's work runs in.
#
# There were five: a runtime for scripts, an office image for documents, an
# office-render image for reading them, a search image for browsing, and a
# joule image for a delegated agent. Four shared a base and differed by a pip
# install. What that bought was a deployment where any one of them could be
# absent and nothing said so: on staging, reading a .docx failed for weeks with
# "the document reader could not start (agents-office-render:2 - is it built?)"
# because that image had never been built there, and run_script failed the same
# way when agents-runtime:1 was missing. A capability that is silently absent is
# worse than an image that is larger.
#
# The playwright image is the base because it is the one thing that cannot be
# added cheaply afterwards: it carries the browsers. Everything else - python,
# the imaging stack, the document libraries, LibreOffice, the office skills and
# the joule release - installs on top.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DEBIAN_FRONTEND=noninteractive

# System libraries: python itself, the imaging stack cairosvg and pillow link
# against, LibreOffice for the formats no library converts, poppler for PDFs,
# git because work handed over is usually a working tree, and fonts because an
# agent asked for a logo with no font falls back to a bitmap face and spends
# its turn deciding that looks wrong.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 libffi8 \
      libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
      pandoc poppler-utils zip unzip \
      curl ca-certificates git \
      fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
  && rm -rf /var/lib/apt/lists/* \
  && (fc-cache -f >/dev/null 2>&1 || true)

RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Everything the work reaches for, in one install. Versions pinned where the
# old images pinned them, so a script that worked against one of them works
# against this.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      pillow cairosvg svgwrite requests \
      playwright==1.56.0 beautifulsoup4 \
      python-docx==1.1.2 \
      openpyxl==3.1.5 \
      python-pptx==1.0.2 \
      docxtpl==0.20.0 \
      lxml==5.3.0 \
      pypdf==5.1.0

# The skills, on PATH under the names their briefings already use. An agent
# that has them does not write that code again inside every turn.
COPY tools/office/ /opt/office/
COPY tools/websearch.py /app/websearch.py
RUN chmod +x /opt/office/*.py \
 && ln -sf /opt/office/read_docx.py /usr/local/bin/read-docx \
 && ln -sf /opt/office/fill_docx.py /usr/local/bin/fill-docx \
 && ln -sf /opt/office/merge_runs.py /usr/local/bin/merge-runs \
 && ln -sf /opt/office/make_docx.py /usr/local/bin/make-doc \
 && ln -sf /opt/office/make_xlsx.py /usr/local/bin/make-sheet \
 && ln -sf /opt/office/make_pptx.py /usr/local/bin/make-deck \
 && ln -sf /opt/office/extract_image.py /usr/local/bin/extract-image \n && ln -sf /opt/office/fetch_image.py /usr/local/bin/fetch-image

# The pin, and the one line to change when bumping it. A tag rather than
# latest: a delegated turn's behaviour is the daemon's behaviour, and an image
# that quietly picked up a new release would change what a conversation does
# with nothing in this repository having moved.
ARG JOULE_VERSION=v0.23.20

RUN set -eu; \
    url="https://github.com/joule-sh/code/releases/download/${JOULE_VERSION}/code-x86_64-linux.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL "$url" -o "$tmp/code.tar.gz"; \
    tar -xzf "$tmp/code.tar.gz" -C "$tmp"; \
    mv "$tmp/code-x86_64-linux" /opt/joule-code; \
    rm -rf "$tmp"

ENV PATH=/opt/joule-code:$PATH
RUN test -x /opt/joule-code/joule && test -x /opt/joule-code/joule-daemon

RUN mkdir -p /home/sandbox /work \
 && chown 65534:65534 /home/sandbox /work
ENV HOME=/home/sandbox

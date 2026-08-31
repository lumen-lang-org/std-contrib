# The environment a delegated joule agent runs in: the joule daemon itself, on
# top of the same toolchain a script run gets, so the agent inside the
# container can do the work someone would otherwise ask it to do at a terminal.
#
# Built on agents-runtime:1 rather than a bare python, because a delegated
# agent is handed an open brief and cannot change image half way through it.
# A skill declares the image it needs before it runs; this agent finds out what
# it needs while it is working, and the only thing it can do about a missing
# library is spend its turn installing one. Every logo asked for here began
# "Pillow isn't installed. Let me install it." — steps bought with the budget
# that was meant for the work, and turns that ran out before they finished.
#
# That is the opposite trade from office.Dockerfile, which stays its own image
# on purpose: a conversation that never asks for a document should not carry
# LibreOffice. The document *libraries* are cheap and are here; LibreOffice and
# pandoc are not, and a delegated agent that genuinely needs to convert a
# format can still be pointed at the office image.
FROM agents-runtime:1

# git because the work handed over is usually a working tree, and a font
# because an agent asked for a logo with no font on the box falls back to a
# bitmap face, decides it looks wrong, and spends the rest of its turn on that.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# The document formats people actually hand over — read a .docx, write a
# .xlsx, fill a template — without the conversion stack that makes the office
# image heavy. Pinned to the same versions office.Dockerfile pins, so a script
# that works there works here.
RUN pip install --no-cache-dir \
    python-docx==1.1.2 \
    openpyxl==3.1.5 \
    python-pptx==1.0.2 \
    docxtpl==0.20.0 \
    pypdf==5.1.0

# The office skills, on PATH under the names their briefings already use. An
# agent that has them does not have to be told how to read a .docx; one that
# does not have to write that code again inside every turn that needs it.
COPY tools/office/ /opt/office/
RUN chmod +x /opt/office/*.py \
 && ln -sf /opt/office/read_docx.py /usr/local/bin/read-docx \
 && ln -sf /opt/office/fill_docx.py /usr/local/bin/fill-docx \
 && ln -sf /opt/office/merge_runs.py /usr/local/bin/merge-runs \
 && ln -sf /opt/office/make_docx.py /usr/local/bin/make-doc \
 && ln -sf /opt/office/make_xlsx.py /usr/local/bin/make-sheet \
 && ln -sf /opt/office/make_pptx.py /usr/local/bin/make-deck \
 && ln -sf /opt/office/extract_image.py /usr/local/bin/extract-image

# The pin, and the one line to change when bumping it. A tag rather than
# `latest`: a delegated turn's behaviour is the daemon's behaviour, and an
# image that quietly picked up a new release would change what a conversation
# does with nothing in this repository having moved.
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

RUN mkdir -p /home/sandbox && chown 65534:65534 /home/sandbox
ENV HOME=/home/sandbox

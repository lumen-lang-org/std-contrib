# LibreOffice, headless, as a converter and nothing else.
#
# This is NOT a script environment. No conversation is ever given one of
# these, no agent can name it, and nothing a model writes reaches it: the
# platform runs it, one container per conversion, to turn a .docx/.xlsx/.pptx
# into the PDF a reader looks at. That is the whole job, which is why the
# image carries no python, no pip and no network tooling — the smaller the
# thing parsing an untrusted document, the better.
#
# Why a converter at all, when the console already had docx-preview and
# pptx-preview: those are re-implementations of a layout engine in JavaScript,
# and they are honest about their limits — charts, SmartArt, gradients and
# anything with real typography degrade. LibreOffice IS the layout engine, so
# one converter replaces both renderers and covers .pptx properly, which was
# the weakest of the three by a distance.
#
# --no-install-recommends is load-bearing: without it this image pulls a Java
# runtime, a print stack and a desktop's worth of themes, and triples in size
# for nothing a headless conversion uses.
FROM debian:bookworm-slim

# The three filters, and the core they share. -writer/-calc/-impress are what
# make .docx/.xlsx/.pptx convertible respectively; drop one and that format
# fails at the filter rather than at the door, which is a much worse error to
# read.
#
# The fonts are not decoration. Carlito is metric-compatible with Calibri and
# Caladea with Cambria — same advance widths, same line heights — which is
# what makes a document written in Word lay out on the same lines here rather
# than reflowing into a substitute. Without them LibreOffice falls back to
# whatever it has and every Word default document renders wrong in a way that
# looks like a rendering bug and is really a missing font. Liberation covers
# Arial/Times/Courier the same way; DejaVu is the last resort that keeps a
# missing glyph from becoming a box.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-core \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation2 \
      fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Warm the font cache at build time so the first conversion does not pay for
# it. A cold fontconfig scan is a couple of seconds, and it would otherwise
# land on whichever document happened to be first.
RUN fc-cache -f >/dev/null 2>&1 || true

# The one writable place, created HERE rather than at runtime, and this is
# load-bearing twice over.
#
# Ownership first: the conversion runs as 65534 under --cap-drop ALL, and
# without CHOWN it cannot give itself a directory. A `mkdir && chown` in the
# container — which is how environments.ts prepares /workspace, because a
# script environment keeps that capability — fails here with "Operation not
# permitted" and leaves the conversion writing into a root-owned directory it
# has no access to.
#
# Not a tmpfs, second. A `--tmpfs /work` looks like the tighter choice and
# silently breaks the whole thing: `docker cp` into a path covered by a tmpfs
# mount writes to the rootfs layer UNDERNEATH the mount, so the file lands
# somewhere the container cannot see, `ls` shows an empty directory, and
# LibreOffice answers "source file could not be loaded" having exited 0. This
# is the container's own writable layer instead — ephemeral all the same,
# since the container is destroyed after one conversion.
RUN mkdir -p /work && chown 65534:65534 /work

# HOME and the font cache both have to be somewhere writable, and neither is
# by default: the run user's home is /nonexistent, so dconf fails, and
# fontconfig answers "No writable cache directories" and then re-scans every
# font on every conversion. The caller sets both to /work; they are declared
# here as well so the image is correct when run by hand.
ENV HOME=/work \
    XDG_CACHE_HOME=/work

# No ENTRYPOINT and no CMD on purpose. office-render.ts overrides the
# entrypoint to `sleep infinity` — the same trick environments.ts uses — so
# the container is something to exec into rather than a program that runs and
# exits. An ENTRYPOINT here would be appended to and quietly break that.

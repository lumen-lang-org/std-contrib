# The environment for scripts that need a browser: screenshots, rendering a
# page to PDF, scraping something that only exists after JavaScript runs.
#
# Built on Microsoft's Playwright image because it already carries Chromium
# and the several dozen system libraries a headless browser needs — assembling
# that by hand is a day of apt archaeology and breaks on every base bump.
#
# Chromium must be launched with --no-sandbox here. Its own sandbox needs
# privileges this container deliberately does not have (caps are dropped to
# five and no-new-privileges is set); the container IS the sandbox, which is
# the same trade every CI runner makes.
FROM mcr.microsoft.com/playwright:v1.56.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
# The python binding, PINNED to the base image's version. An unpinned install
# takes the newest release, which expects browser builds this image does not
# carry — the failure is "Executable doesn't exist at /ms-playwright/...",
# which reads like a broken image and is really a version skew.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pip3 install --no-cache-dir --break-system-packages \
      playwright==1.56.0 pillow requests beautifulsoup4
# `python` as well as `python3`, because run_script's python runtime is
# spelled without the 3.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

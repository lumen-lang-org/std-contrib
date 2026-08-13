# The environment for search_web's fallback: the plain HTTP path this skill
# tries first is the one that gets blocked, so the browser path behind it
# needs the same Chromium runtime as agents-web:1 (see runtime-web.Dockerfile
# for why that base and why --no-sandbox). Its own image rather than reusing
# agents-web:1 so websearch.py — this deployment's own script, staged under
# tools/ the same way office's scripts are — has a fixed, known path to run
# from, independent of whatever else agents-web:1 is asked to do.
FROM mcr.microsoft.com/playwright:v1.56.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pip3 install --no-cache-dir --break-system-packages \
      playwright==1.56.0 requests beautifulsoup4
RUN ln -sf /usr/bin/python3 /usr/local/bin/python
COPY tools/websearch.py /app/websearch.py

# The environment a conversation's scripts run in. Python and node together,
# with the system libraries the common imaging/data packages need at runtime,
# so "pip install cairosvg pillow" works without apt and apt works when it must.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 libffi8 \
    curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pillow cairosvg svgwrite requests

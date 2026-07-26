# Build the agents API with the Lumen toolchain, run the bare binary.
#
# The output is a statically-linked native binary with no runtime, which is
# why the final stage is a scratch-thin base and the image stays small.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils git \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/lumen-lang-org/lumen/main/install.sh | sh
ENV PATH="/root/.lumen/bin:${PATH}"

WORKDIR /src
# The API imports its siblings by relative path, so the build context is the
# repository root and the whole packages tree comes along.
COPY packages ./packages
RUN cd packages/agents && lumen compile api.ts && ls -la api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --home /data agents && mkdir -p /data && chown agents /data
COPY --from=build /src/packages/agents/api /usr/local/bin/agents-api
USER agents
WORKDIR /data
EXPOSE 8100
# LUMEN_MASTER_KEY comes from the environment at run time, never from here.
ENTRYPOINT ["agents-api"]

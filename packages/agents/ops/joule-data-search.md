# Changes made on joule-data, which keeps no git

The search index and its API live at `/data/joule/app` on **joule-data**
(100.110.210.29), and that directory is not a repository. Everything below was
edited in place on 2026-08-19 and exists only on that disk: if the box is
rebuilt from the upstream source, each one comes back.

Manticore listens on 9306/9308 to that host only, so the API on :8080 is the
only way in from anywhere else.

## 1. Hybrid search never queried a vector — the query embedder was unreachable

`knnSearch` (src/vectors.ts) embeds the query before it can ask Manticore for
neighbours. `vectorConfig()` defaults to ollama at `100.115.253.119:11434`,
which does not answer on this host, so every embed failed and `knnSearch`
returned `[]`. `fuseWithVectors` reads an empty neighbour list as "no vectors
yet" and hands back the lexical order — silently, by design — so hybrid search
was BM25 wearing its name, for correctly spelled queries as much as typos.

Fixed with a systemd drop-in, `/etc/systemd/system/joule-api.service.d/embedder.conf`:

    [Service]
    Environment=JOULE_EMBED_API=openai
    Environment=JOULE_OLLAMA_URL=http://100.115.253.119:8000
    Environment=JOULE_EMBED_MODEL=granite-embedding

That vLLM serves the same 768-dim granite the corpus was embedded with, so the
vectors already stored match a query embedded there. Measured after: "why is my
computer slow" lands 0.09 from "Ultimate Computer Lagging Guide" and pulls a
Portuguese page for an English question, and `wy is my computr slllow` returns
three hits where BM25 alone returns none.

The `[Service]` header matters. Without it systemd parses none of the file and
reports no error.

## 2. Coverage counted pages that cannot have been embedded

`vectorFrontier` (src/pg-admin.ts) and `vectorCoverage` (src/pg-store.ts) both
took their total from `doc_counters key = 'docs'` and subtracted the pending
count. `pending` only counts documents whose `index_state = 'indexed'`, so the
~800k pages not yet indexed were counted as embedded. That reported 813,753 of
drift against Manticore when the real gap was about 15,000.

Both now read `key = 'indexed'`. A crawl that never stops always has some
drift; the number is only useful if it says how small.

## 3. A postgres blip answered "you have nothing"

`cfgRead` (src/server.ts) caught any error from postgres and fell back to the
sqlite store. Every table in `/data/joule/store/joule.db` has been empty since
the cutover to postgres — 20 tables, 0 rows — so that fallback could only ever
answer "no feeds, no synonyms, no rules" to a question about configuration
somebody had written. It now logs and rethrows.

The sqlite file is still opened at boot and still carries WAL and SHM. Nothing
reads anything from it. Removing it is a real change — `Store` is constructed
for the corpus and frontier paths and five crawl processes share the file — and
it wants doing when somebody can watch the crawl afterwards.

## 2026-08-19 — the sqlite fallback is retired

`aggGet` in `src/server.ts` now throws when `pgReadPool()` is non-null:
every table in the sqlite copy has been empty since the Postgres cutover,
so the fallback lanes could only answer zeros at the exact moment Postgres
was down. Dashboards now see an error instead of an empty index. The file
`/data/joule/store/joule.db` (184K) is still opened by `openStore` at boot;
removing that handle is docs/22 stage B. `/data/joule/crawl3/data/joule.db`
(13G) is the crawl shard's own working store and is NOT part of this.
Backup of the edit: `src/server.ts.bak-sqlite-retire`.
Also deleted the six `docflow-expert` prompt rows from the engine's
Postgres (no agent pointed at them; prompts have no DELETE route).

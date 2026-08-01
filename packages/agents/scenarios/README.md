# Scenario evals for the docflow deployment

Deployment-specific, deliberately: the platform stays generic, and what is
particular to the docflow agent — its validator image, its examples, its
skills — lives here as runnable scenarios rather than in platform code.

Each script drives real conversations over the running API (127.0.0.1:8100)
and scores against ground truth it computes at run start — the validator's
own verdicts, the proto descriptor set — never against a fixture that can go
stale.

    python3 scenarios/validate_examples.py       # the six image examples as uploads
    python3 scenarios/skills_cases.py            # six skill-routing cases incl. enum honesty
    python3 scenarios/add_steps_import_chain.py  # the edit_hard case: add 3 steps, rewire, converge

The Mistral key rate-limits in bursts; a 429 mid-turn voids the whole round
and the scripts retry with long backoff. Pause the indexer for a clean run.

Two scripts here are not evals — they are operations, kept beside them because
they are the same kind of thing: committed scripts rather than something typed
into a shell at three in the morning.

    python3 scenarios/backfill_owner.py --owner <uuid>          # dry run
    python3 scenarios/backfill_owner.py --owner <uuid> --write  # claim them
    python3 scenarios/lock_probe.py                             # after every deploy

Run the backfill at cutover, once, before `AGENTS_TRUST_PROXY_AUTH` goes on.
Everything written before owners existed carries `owner = ''`, and the guard is
exact equality, so that history is reachable by nobody until somebody claims it
— which is the point: the other reading would hand it to whoever logs in first.

`lock_probe.py` asks the running engine whether it wants the bearer token it
was configured with, and it runs in both states: with no `AGENTS_API_TOKEN` it
asserts the opposite and prints that the lock is off. A probe that passes
because it checked nothing is how the top risk in GATEWAY.md — `:8100`
reachable with the trust gate on — actually happens.

What is NOT here: the owner-scoping e2e — the 401 matrix, two-tag isolation,
the trust gate off, a long POST, a non-admin preview. Those assert the gateway's
config as much as this engine's guards, so they live beside it, in the nuraly
repo under `e2e/agents/`. Whichever repo the config is in is the repo the test
has to be committed to, or the two can go green in different commits.

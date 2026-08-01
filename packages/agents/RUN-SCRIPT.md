# Letting a script do the work

Eight tool steps is eight round trips. A script that reads a document, walks
every occurrence, rewrites them and prints what it changed is **one**. It also
does what no tool set will: validate with a real library, transform four hundred
entries, compute something before deciding what to write.

The decision (2026-07-28): scripts run in **containers, one environment per
conversation** — and a conversation can have more than one if it wants them.
An environment is where a conversation's computational state lives: the
runtimes, anything installed into it, anything cached between runs. Docker is
the engine; the earlier namespaces-per-run design is superseded, and spec 480
(`confinedSpawn`) no longer gates this feature — the server only needs to drive
the `docker` CLI, which `child_process.spawnSync` already can.

## The model

**An environment exists only because the agent decided to run something.** A
conversation that stays conversation — questions, answers, artifacts written
and edited — never has a container, costs no disk and appears in no ceiling.
The first `run_script` call is what creates one; that a model reached for the
tool *is* the decision, and there is no other way to make one. Named `main`
unless the caller says otherwise, and a conversation may create more — `main`
for python work, `web` for a node toolchain — each a row and each its own
container:

```
environments: id, thread_id, name, image, status, created_at, last_used_at
```

**It hibernates and warms up.** Idle past a deadline (say 15 minutes), the
container is stopped — it costs disk, not CPU or memory. The next `run_script`
starts it again; a `docker start` is a few hundred milliseconds, paid once per
return to the conversation rather than once per run. A stopped environment
survives an API restart; a deleted conversation deletes its environments.

**State persists inside it, but the truth stays in Postgres.** The container
keeps a workspace between runs — a venv, node_modules, build caches, scratch
files. None of that is the record: artifacts remain rows, and every run still
goes materialise → run → reconcile against the named paths. Anything the
container holds that was never reconciled into an artifact is cache, and losing
it (a rebuilt image, a pruned host) must never lose work. That is the line that
keeps a crashed container from being a data loss.

## The tool

```ts
run_script({
  language: string,      // "python" | "node" | "sh" — a binary the image has
  source: string,        // the script; untrusted model output
  paths: string[],       // artifacts to materialise, explicit, never "all"
  mayCreate: bool,       // may it create files not in `paths`
  environment: string,   // optional; "" means "main"
})
```

The reply is unchanged from the earlier design: `ok`, `stdout`, `stderr` (always,
especially on failure), `changed`/`created`/`unchanged`/`refused` with versions,
`stopped` naming what ended it.

## The boundary, per run

Same three moves as before, now inside the environment's container:

- **Materialise** the named paths' newest versions into the run directory
  inside the container (`docker cp` or a bind mount). Fresh per run: the
  *workspace* persists, the *run directory* does not, so a script cannot be
  poisoned by a stale copy of an artifact its conversation has since rewritten.

  The directory is `/artifacts`, and the name is part of the contract — the
  tool's description says it, and the script starts there. It was once
  `/tmp/lumen-run-<id>`: unguessable, which mattered to nothing, since one
  script at a time per environment and no container shared between
  conversations already rule out the collision the id was avoiding. What it
  cost was paid by the model. An agent given an uploaded docflow to repair
  spent its whole step budget guessing where the file was — the artifact path,
  `/tmp`, `/workspace`, `/app` — and a small one, having failed to find the
  document it was asked to fix, wrote a clean docflow of its own and validated
  that instead, reporting a pass on a file the user had never sent. Fresh per
  run is the guarantee; unique per run never was.
- **Run** as a non-root user, with CPU, memory, pids and a wall-clock timeout
  capped, output capped, and the run directory the only place the reconcile
  will look.
- **Reconcile** exactly as specified before: byte-identical mints no version;
  changed appends a version through the same validation as `write_artifact`;
  new files need `mayCreate`; **nothing is ever deleted**; a path whose newest
  version moved during the run is refused by version precondition, the rest
  still land.

## Network

Off by default (`--network none`). An environment may be created with network
on — that is what makes `pip install` and richer environments possible, and it
is the single riskiest switch in this design: a script is model output, and a
model that can be prompted into `curl`ing a secret out is the attack the
default exists for. So: network is a property of the *environment*, chosen at
creation, visible in the UI, never flipped silently by a script — and the
briefing tells the model which environments have it.

## Limits

- **Running containers per deployment**: a hard ceiling. At the ceiling,
  starting one more is a refusal naming the count, not a queue — a queue built
  from blocked handler threads is the same exhaustion with a longer name.
- **One script at a time per environment**: a second is refused, naming the run
  in flight. Two conversations never share a container, so the per-thread race
  is structural, not policed.
- **Handler threads are still the scarce thing**: the HTTP pool is sized to CPU
  count and a script holds its thread for the whole run. The script ceiling
  stays well below the pool size so the API keeps answering — including the
  steps poll that draws the card showing the script run.
- **Disk quota per environment**, because persistent state grows and fifty
  conversations times an unbounded workspace is the host's disk gone.

## Failure table

| what goes wrong | what happens |
|---|---|
| the language is not in the image | refused, naming what is available |
| a path is not an artifact of this thread | refused; nothing runs |
| the script throws or times out | `ok: false`, stderr/`stopped` say why, nothing written |
| output past the cap | killed, captured prefix kept, nothing written |
| a file grew past `ARTIFACT_MAX` | that path refused, the others reconciled |
| a file deleted in the run dir | reported; the artifact is untouched |
| created without `mayCreate` | reported in `refused`, dropped |
| newest version moved mid-run | that path refused with both versions |
| the environment's container is gone (pruned, host rebuilt) | recreated from the image; workspace cache lost, artifacts untouched — say so in the reply |
| the deployment is at its container ceiling | refused, nothing started |
| the environment already has a script running | refused, naming it |
| docker itself is absent or broken | the tool is not offered at all |

The last row keeps the old rule: absent, not offered-and-failing. A model
cannot call a tool it was never told about.

## Build order

1. **Materialise and reconcile against a plain directory** — no docker at all.
   The half that loses data, built and tested first. (Unchanged from the
   earlier design and already the right first slice.)
2. **The environments table and lifecycle**: create on first use, stop on
   idle, start on return, delete with the thread. Driven through the docker
   CLI via `spawnSync`; a fake `docker` binary on `PATH` makes this testable
   without the daemon.
3. **`run_script`** wiring the two together, with the caps and the reply shape.
4. **The ceilings**: deployment count, per-environment lock, disk quota —
   refusing, with tests that hold one run open.
5. **Network-enabled environments**, last, because it is the risky switch:
   creation-time only, surfaced in the UI and the briefing.
6. **An e2e through the composer**: a script rewrites four hundred entries,
   one version appended, the model reads its own stdout back; then a second
   run in the same environment reuses state the first left behind.

## What it deliberately cannot do

No shell string to quote: `language` names a runtime, `source` is a program,
arguments never pass through a shell. No implicit deletion, ever. No script
may flip its environment's network on. And the workspace is cache, not record:
the reply says so whenever an environment was recreated cold.

# Letting a script do the work

Eight tool steps is eight round trips. A script that reads a document, walks
every occurrence, rewrites them and prints what it changed is **one**. It also
does what no tool set will: validate with a real library, transform four hundred
entries, compute something before deciding what to write.

So when a command can be run safely — that is spec 480, `confinedSpawn`, and
not before — the model should be able to write a script and run it against this
conversation's files.

The running is 480's problem. This document is about the part 480 does not
touch and that is where the data loss would come from: **artifacts are rows in
Postgres and a script wants files on a disk.** Everything below is the boundary
between those two facts.

## What this replaces, and what it does not

It replaces the fixed transform set (task #29). That existed because a script
was unsafe; a fixed vocabulary of transforms is a worse script with a smaller
grammar, and once scripts are safe there is no reason to keep it.

It does not replace `edit_artifact`. Changing one line should not spawn a
process, materialise a directory and reconcile a diff. Two doors, chosen by
size: a tool for a change the model can state, a script for work it has to
compute.

It also does not replace the Lumen validator in `SCHEMA-WORK.md` so much as
demote it — with a sandbox, `ajv` in a container beats every line of it, and
that document already says so.

## The tool

```ts
run_script({
  // What the script is written in. A fixed set, each a binary that exists in
  // the image: "python", "node", "sh". Not a path — a name the server maps.
  language: string,
  // The script itself. Untrusted model output, like every other argument here.
  source: string,
  // The artifacts to put in front of it, by path. Explicit, never "all": a
  // script that can see every file in the conversation is a script that can
  // rewrite every file in the conversation by accident.
  paths: string[],
  // Whether it may create files that were not in `paths`.
  mayCreate: bool,
})
```

The reply is what the model needs to act on, which is more than an exit code:

```
{"ok": true,
 "stdout": "rewrote 412 entries\n",
 "stderr": "",
 "changed": [{"path": "/data.json", "version": 4, "bytes": 208431}],
 "created": [{"path": "/report.md", "version": 1, "bytes": 1902}],
 "unchanged": ["/schema.json"],
 "refused": []}
```

**`stderr` comes back even when the run succeeds, and especially when it does
not.** A script that fails hands the model a traceback to fix; a bare exit
status hands it nothing and the next step is a guess.

## The boundary

Three moves, and the third is the whole risk.

**Materialise.** Each named path's newest version is written into an empty
directory inside the sandbox, at its own path. Nothing else is there: not the
other artifacts, not the workspace, not a temp file from a previous run. The
snapshot records, per path, the version number it came from.

**Run**, under 480's confinement: no network, no environment, no credentials, a
timeout, an output cap, and `write` scoped to that one directory. The script is
model output and gets exactly the treatment any other command from a model gets.

**Reconcile.** After the run, every file in the directory is compared with the
snapshot it came from:

- **byte-identical** — nothing is written. This matters more than it looks: a
  script that rewrites a file to the same bytes must not mint a version, or a
  loop that runs twice doubles the version history for no change.
- **different** — a new version is appended, exactly as `write_artifact` would,
  with the same path validation and the same size ceiling (`ARTIFACT_MAX`,
  524,288 bytes).
- **new, and `mayCreate`** — a new artifact, its path validated like any other.
  Without `mayCreate` it is reported in `refused` and dropped, because a script
  that writes a file nobody asked for is usually a script that went wrong.
- **gone** — **nothing is deleted.** A missing file is reported and the artifact
  is left alone. Deletion is not something a script gets to do implicitly: a
  crashed interpreter, a `rm -rf` in the wrong directory, an unhandled
  exception halfway through — all of them look exactly like "the file is gone",
  and none of them is a request to destroy a version history.

## The race, which is the reason for the snapshot

A round is not alone. Another round of the same thread may write the same path
while the script is running, and a script that materialised version 3 and writes
back version 4 would erase what version 4 already said.

So the snapshot's version is a precondition: **if the stored newest version of a
path is no longer the one that was materialised, that path is refused** — named
in `refused`, with what it was and what it is now — and the rest of the run is
still reconciled. Partial success, reported precisely, beats an atomic failure
that throws away four hundred good rewrites because one file moved.

This is the same rule `edit_artifact` needs and for the same reason, and the two
should share it rather than each inventing one.

## Why the paths are explicit

Three reasons, in order of how much they cost when ignored.

A script with every file in front of it can rewrite every file. A bug in the
model's script becomes a bug in every artifact of the conversation, and the only
recovery is version history, one path at a time.

The materialise step is a copy: a conversation with fifty artifacts is fifty
files written before the script starts, on every run.

And an explicit list is a statement of intent that can be checked. When the
reply says a file changed, the model asked for that file to be in front of the
script; when it says a file was refused, the model can see why.

## How many at once

Not a pool. Namespaces are cheap — twenty confined spawns of user, mount and PID
namespaces measured 49ms in total on a six-core host, 2.4ms each — so there is
nothing to amortise and a pool would add a lifecycle, a reuse-contamination
question and a warm-up path to save two milliseconds. That is the argument for
480 being namespaces rather than a container runtime, and it is the argument
against pooling too.

What is shared is the **read-only runtime tree**: the language binaries and their
standard libraries, built once at deploy and bind-mounted read-only into every
run. Every concurrent script sees the same one, safely, because none of them can
write to it. What is per-run is the namespaces and the writable directory, made
and destroyed each time, so two scripts are independent by construction rather
than by discipline.

**The resource that has to be capped is neither of those. It is handler
threads.** The language's HTTP server dispatches each request to a thread pool
sized to the CPU count — six, on the host this was measured on — and a script
holds its handler thread for the whole run, up to its timeout. Three concurrent
thirty-second scripts is half the API's capacity gone. Six is a server that
answers nothing else, including the `/threads/:id/steps` poll that draws the
card showing the script running. The feature that shows progress is the first
casualty of the feature that needs it.

So there is a hard ceiling on scripts running at once, well below the pool size,
and reaching it is a **refusal**, not a queue:

    {"ok": false, "error": "two scripts are already running for this deployment;
     nothing was started. Try again when one finishes."}

Refusing rather than queueing, for a reason worth stating: a queue built out of
blocked handler threads is not a queue, it is the same exhaustion with a longer
name. The caller is a model in a round with a step budget; it can spend a step
being told to wait, and that is cheaper than a thread parked until a timeout it
cannot see.

Two further limits belong with it. **One script at a time per thread** — a
conversation cannot start a second script while its first is running, because
two scripts materialising the same paths is the version race in the reconcile
section, made deliberately. And the ceiling is a **deployment** number, not a
per-thread one: ten threads each politely running one script is the same dead
server.


## Failure table

| what goes wrong | what happens |
|---|---|
| the language is not one of the fixed set | refused before anything is materialised, naming what is available |
| a path is not an artifact of this thread | refused, naming the path; nothing runs |
| `paths` is empty | refused; a script with nothing in front of it wants `confinedSpawn`, not this |
| the script does not compile or throws | `ok: false`, `stderr` carried back whole, **nothing written** |
| the script times out | `ok: false`, `stopped: "timeout"`, nothing written — a half-finished transform is not a version |
| the script prints past the output cap | killed, the captured prefix kept, nothing written |
| a file grew past `ARTIFACT_MAX` | that path refused, named, the others still reconciled |
| a file was deleted | reported, artifact untouched |
| a file was created without `mayCreate` | reported in `refused`, dropped |
| the newest version moved during the run | that path refused, naming both versions |
| the script writes outside its directory | the kernel refuses it; the script sees the error |
| the deployment is already at its script ceiling | refused, nothing materialised, nothing started |
| the thread already has a script running | refused, naming the run in flight |
| the platform cannot confine | **the tool is not offered at all** |

That last row is the one that decides whether this feature is safe or is a story
about being safe. If `confinedSpawn` cannot enforce on this host, `run_script`
must not appear in the tool list — not appear and fail, not appear and fall back.
A model cannot call a tool it was never told about.

## Build order

1. **Materialise and reconcile, with no script at all** — a function that
   writes the named versions into a directory and reads them back, and a test
   that byte-identical files mint no version. This is the half that loses data,
   so it is built and tested before anything can run.
2. **The version precondition** and the `refused` list, with a test that moves a
   path underneath a snapshot.
3. **480's `confinedSpawn`**, which is a Lumen change and gates everything after.
4. **`run_script`** as a tool: the language set, the caps, the reply shape.
5. **The concurrency ceiling** — a deployment count and a per-thread lock, both
   refusing rather than queueing, with a test that holds one run open and
   asserts the second is refused without materialising anything.
6. **The tool list gate** — the tool is offered only where confinement is
   enforceable — with a test asserting its absence rather than its refusal.
7. **An e2e through the composer**: a document, a script that rewrites four
   hundred entries, one version appended, and the model reading its own
   `stdout` back.

## What it deliberately cannot do

No network, so no fetching a package. The image has what it has: a language
runtime and its standard library, plus whatever validators are baked in
deliberately.

No persistence between runs. Each run gets an empty directory built from the
snapshot, so a script cannot leave itself a note, and two runs cannot disagree
about what is on disk.

No shell composition. `language` names a runtime and `source` is a program —
there is no command line to quote, and nothing that reads a string as a command.

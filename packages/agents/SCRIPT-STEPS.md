# The SCRIPT step

A workflow step whose body is Lumen, compiled to wasm and run with no
capabilities at all. `script-wasm.ts` is the whole of it; `workflow-run.ts`
calls it like any other step adapter.

## What makes it safe

Not a sandbox we configure — an artifact with no doors in it.

Compile a program that calls `http.request` to wasm and the module imports
thirty WASI functions and **not one socket call**. The network is not denied;
the instruction for it does not exist. What remains is WASI's file and clock
surface, and WASI files are capability-based: a `path_open` can only reach a
directory the host preopened. Grant none and it reaches nothing.

So the run gets exactly one directory — holding the one file it may read —
no environment, and a timeout.

| the guarantee | what enforces it |
|---|---|
| no network | the compiled module has no socket instruction |
| no files but its own | one `--dir` preopen, and nothing else |
| no environment | no `--env` is passed |
| it ends | wasmtime `-W timeout`, and `timeout(1)` around the runtime |
| it cannot flood the walk | `SCRIPT_OUT_MAX` on what it may answer with |

The second timeout is not belt-and-braces for its own sake: the epoch budget
is spent on **wasm instructions**, so a script sitting inside a blocking host
call is never interrupted by it. The wall clock is what covers that.

## What this machine needs

Neither of these is in the image, and without them the step fails at run time
rather than at deploy time — which is why they are written down here.

**`wasmtime`.** A single binary; any recent release works.

```
curl -sSL https://github.com/bytecodealliance/wasmtime/releases/download/v27.0.0/wasmtime-v27.0.0-x86_64-linux.tar.xz \
  | tar -xJ --strip-components=1 -C /usr/local/bin wasmtime-v27.0.0-x86_64-linux/wasmtime
```

**The `lumen` compiler**, because a script is compiled on its first run. The
compile is the only part that touches the network — URL imports resolve there
— which is exactly why the build and the run are separate.

**Both named to the units**, since neither is on a systemd `PATH`:

```ini
# /etc/systemd/system/joule-engine.service.d/script.conf
# and the same file under joule-scheduler.service.d/
[Service]
Environment=AGENTS_LUMEN_BIN=/home/ubuntu/.local/bin/lumen
Environment=AGENTS_WASMTIME_BIN=/usr/local/bin/wasmtime
Environment=AGENTS_SCRIPT_CACHE=/home/ubuntu/projects/std-contrib/packages/agents/script-cache
```

Both default to the bare name on `PATH`, which is what a developer's box has;
the drop-in exists for the deployed one.

## The cache

A module is keyed by the SHA-256 of its whole source, prelude included — so
the same text is the same module, editing a step and putting it back costs
nothing, and changing what a script is handed rebuilds everything.

It is swept after a fresh build: past `SCRIPT_CACHE_KEEP` entries the oldest
goes. Every edit of a step mints another ~50KB module, so unswept this grows
for as long as somebody is working.

## Two things that cost an afternoon

**`lumen compile` has no `-o`** and writes its output to the *working
directory*, not beside the source. The source is therefore named for its hash
and the artifact moved into place — otherwise two builds race over one
`step.wasm` in the engine's own directory, and every build "fails" while
quietly succeeding.

**A preopen must be mounted at `/`** with a *relative* read inside the module.
`--dir=box::/in` with `fs.readFileSync("/in/x")` answers `PermissionDenied`.

## What a script sees

`prev()`, `input()` and `node("<id>")` — the same values the fields read as
`{{prev}}`, `{{input}}` and `{{node.<id>}}`. They are files in the granted
directory rather than a document to parse: the capability directory IS the
API, so there is no parser in the prelude and nothing to escape.

The prelude sits above the person's own `main()`, which means the compiler
counts lines from ITS top — every diagnostic is moved back onto the line they
actually wrote before it is shown.

// A SCRIPT step: source in, wasm out, run with nothing granted.
//
//   let built = ensureBuilt(node.source);           // compiles once per hash
//   let ran   = runScript(built.path, inputJson);   // no net, no env, one dir
//
// WHY WASM AND NOT A CONTAINER. A native binary calls libc directly, so its
// permissions can only be enforced around the process — seccomp, namespaces,
// an egress proxy — and every layer is a thing to get wrong. A wasm module's
// only doors are the imports the host supplies. Compiling a program that
// calls http.request to wasm produces a module importing thirty WASI
// functions and NOT ONE SOCKET CALL: the network is not denied, the
// instruction for it does not exist. That is a stronger claim than any
// sandbox configuration, and it is free.
//
// What a script may therefore do: compute. It reads the step's input from a
// file in the one directory the runner grants and writes its answer to
// stdout. It cannot open a socket, read the engine's environment, or see any
// path outside that directory — verified: without the --dir the same read
// answers PermissionDenied.
//
// Reaching out is the GRAPH's job. There is an HTTP step, a web search step
// and a documents step already, each with its own credentials and its own
// refusals. A script that cannot do I/O is not a crippled script; it is the
// half of the work that has no business holding a credential.
//
//   cd packages/agents && lumen test script-wasm.test.ts

import { MAX_SOURCE } from "../workflow/workflow.ts";

// Where the compiler and the runtime are. Both overridable because a
// deployment may keep them anywhere, and both defaulting to the name on the
// PATH, which is what a developer's box has.
export function lumenBin(): string {
  return process.env("AGENTS_LUMEN_BIN") ?? "lumen";
}

export function wasmtimeBin(): string {
  return process.env("AGENTS_WASMTIME_BIN") ?? "wasmtime";
}

/** Where built modules live, keyed by the hash of their source. */
export function scriptCacheDir(): string {
  return process.env("AGENTS_SCRIPT_CACHE") ?? "/tmp/joule-script-wasm";
}

// How long a step's script may run before the runtime stops it, and how much
// it may answer with. The timeout is wasmtime's own epoch interruption, so a
// `while (true)` costs exactly this and not a hung scheduler — measured at
// 2.07s for a 2s budget against a spinning loop.
export const SCRIPT_TIMEOUT_S: int = 5;
export const SCRIPT_OUT_MAX: int = 262144;

export type ScriptBuild = {
  ok: bool,
  path: string,
  // The compiler's own words when it refused, first line, for the panel.
  error: string,
  // Whether this call did the compiling. False means the cache had it.
  fresh: bool,
};

// Not `ScriptRun` — run-script.ts, the docker runner, already owns that name
// in this package, and two types with one name is a refusal from the
// compiler. The two are neighbours on purpose: that one runs a person's
// script in a container with their files; this one runs a step's script in a
// sandbox with nothing.
export type WasmRun = {
  ok: bool,
  output: string,
  error: string,
};

/* What every script gets above its own text.
 *
 * The expression language reads {{prev}}, {{input}} and {{node.<id>}}; a
 * script reads prev(), input() and node("<id>"). Same vocabulary, so moving a
 * step from a field to a script is a rewrite of the logic and not of the
 * nouns.
 *
 * They are FILES, not a JSON document to parse. The runner grants exactly one
 * directory, so that directory can be the API: one file per value, read
 * whole. No parser in the prelude, no escaping to get wrong, and a script
 * that wants a step's answer as bytes gets it as bytes. `given()` is the
 * whole envelope for anything that wants to iterate.
 *
 * The user's own `main()` is still the entry point. Wrapping their body in a
 * function of ours would mean their line numbers no longer match the compiler
 * errors they are shown, and those errors are the only debugger they have. */
const PRELUDE: string =
  "// --- given by the workflow ------------------------------------------\n"
  + "// These are the step's inputs. Everything else is up to you; there is\n"
  + "// no network, no environment, and no file outside this directory.\n"
  + "function given(name: string): string {\n"
  + "  try { return fs.readFileSync(name); } catch (e) { return \"\"; }\n"
  + "}\n"
  + "/** The previous step's answer. */\n"
  + "function prev(): string { return given(\"prev\"); }\n"
  + "/** What the run was started with. */\n"
  + "function input(): string { return given(\"input\"); }\n"
  + "/** Any earlier step's answer, by the id the drawing gives it. */\n"
  + "function node(id: string): string { return given(\"node-\" + id); }\n"
  + "// --------------------------------------------------------------------\n";

/** The source as it is actually compiled: the prelude, then what was
 *  written. */
export function fullSource(source: string): string {
  return PRELUDE + source;
}

/** The name a source compiles to. The hash is the identity: the same text is
 *  the same module, so editing a step and putting it back costs nothing.
 *
 *  Over the WHOLE source, prelude included — change what a script is handed
 *  and every module must be built again, which a hash of the body alone
 *  would not notice. */
export function scriptHash(source: string): string {
  return crypto.sha256(fullSource(source));
}

function scriptDir(hash: string): string {
  return scriptCacheDir() + "/" + hash;
}

export function scriptWasmPath(hash: string): string {
  return scriptDir(hash) + "/step.wasm";
}

function firstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  return text.slice(0, end).trim();
}

/** The compiler's refusal, as a sentence somebody can act on.
 *
 *  Lumen reports `file.ts:3:7: error: ...` with the offending line under it.
 *  The path is a temporary directory nobody has heard of, so it is cut off
 *  and what remains is the position and the reason. */
export function compilerSaid(stderr: string, stdout: string): string {
  let text = stderr.trim() == "" ? stdout : stderr;
  let i: int = 0;
  while (i < text.length) {
    let line = "";
    let j = i;
    while (j < text.length && text.charCodeAt(j) != 10) { line = line + text.charAt(j); j = j + 1; }
    if (line.includes("error:")) {
      let at = line.indexOf("step.ts:");
      let said = at < 0 ? line.trim() : line.slice(at + 8).trim();
      return said.length > 300 ? said.slice(0, 297) + "..." : said;
    }
    i = j + 1;
  }
  let one = firstLine(text);
  return one == "" ? "the compiler refused it and said nothing" : one;
}

/** Compile this source to wasm, unless a module for it is already built.
 *
 *  Compiling needs the network — URL imports resolve here, at build time, and
 *  never at run time — which is exactly why the two are separate: the build
 *  reaches out, the run cannot. */
export function ensureBuilt(source: string): ScriptBuild {
  let hash = scriptHash(source);
  let dir = scriptDir(hash);
  let wasm = scriptWasmPath(hash);
  if (source.trim() == "") {
    let none: ScriptBuild = { ok: false, path: "", error: "there is no script to compile", fresh: false };
    return none;
  }
  if (source.length > MAX_SOURCE) {
    let big: ScriptBuild = { ok: false, path: "",
      error: "that script is " + `${source.length}` + " characters — the most a step may carry is " + `${MAX_SOURCE}`,
      fresh: false };
    return big;
  }
  try {
    if (fs.existsSync(wasm)) {
      let had: ScriptBuild = { ok: true, path: wasm, error: "", fresh: false };
      return had;
    }
    if (!fs.existsSync(scriptCacheDir())) { fs.mkdirSync(scriptCacheDir()); }
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir); }
    fs.writeFileSync(dir + "/" + hash + ".ts", fullSource(source));
  } catch (e) {
    let broke: ScriptBuild = { ok: false, path: "",
      error: "the script could not be written down to compile: " + e.message, fresh: false };
    return broke;
  }
  // --wasm, never a native build: the whole safety argument is that the
  // artifact has no instruction for the network.
  let res = child_process.spawnSync(lumenBin(), ["compile", "--wasm", dir + "/" + hash + ".ts"]);
  // THE OUTPUT LANDS IN THE WORKING DIRECTORY, not beside the source, and
  // `lumen compile` takes no -o. So the source is named for its hash and the
  // artifact is moved into place: two compiles at once cannot then collide
  // over one `step.wasm` in the engine's own directory. The first version
  // wrote to the cache and looked for it there, and every build "failed"
  // while quietly succeeding.
  let dropped = hash + ".wasm";
  if (res.status != 0 || !fs.existsSync(dropped)) {
    try { if (fs.existsSync(dropped)) { fs.rmSync(dropped, false); } } catch { }
    let refused: ScriptBuild = { ok: false, path: "",
      error: compilerSaid(res.stderr, res.stdout), fresh: true };
    return refused;
  }
  try {
    fs.writeFileSync(wasm, fs.readFileSync(dropped));
    fs.rmSync(dropped, false);
  } catch (e) {
    let stuck: ScriptBuild = { ok: false, path: "",
      error: "the compiled step could not be put away: " + e.message, fresh: true };
    return stuck;
  }
  let made: ScriptBuild = { ok: true, path: wasm, error: "", fresh: true };
  return made;
}

/** Run a built module over one input.
 *
 *  Everything the module can reach is in this argument vector: one directory,
 *  holding one file, which this function wrote. No --env, no network flag
 *  (there is none to give), and a timeout the runtime enforces itself. */
export type ScriptGiven = {
  input: string,
  prev: string,
  // Every earlier answer, as id and text. Written one file per entry.
  outputs: ScriptOut[],
};

export type ScriptOut = {
  id: string,
  output: string,
};

/** An id that may become a filename. The ids a drawing makes are already
 *  tame, but a name is a path the moment it is joined to one, and a step
 *  called "../../etc" must not be able to say where its file goes. */
function tameId(id: string): bool {
  if (id == "" || id.length > 64) { return false; }
  let i: int = 0;
  while (i < id.length) {
    let c = id.charAt(i);
    let ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-" || c == "_";
    if (!ok) { return false; }
    i = i + 1;
  }
  return true;
}

export function runScript(wasmPath: string, given: ScriptGiven, callDir: string): WasmRun {
  try {
    // Both levels: mkdirSync makes one directory, not a path, and a missing
    // PARENT here failed silently — no throw to catch — leaving wasmtime to
    // report "No such file or directory" about a preopen, which reads as a
    // broken module rather than a directory nobody made.
    let cut = callDir.lastIndexOf("/");
    if (cut > 0) {
      let parent = callDir.slice(0, cut);
      if (!fs.existsSync(parent)) { fs.mkdirSync(parent); }
    }
    if (!fs.existsSync(callDir)) { fs.mkdirSync(callDir); }
    // One file per value: the granted directory IS the API the prelude reads.
    fs.writeFileSync(callDir + "/input", given.input);
    fs.writeFileSync(callDir + "/prev", given.prev);
    let o: int = 0;
    while (o < given.outputs.length) {
      if (tameId(given.outputs[o].id)) {
        fs.writeFileSync(callDir + "/node-" + given.outputs[o].id, given.outputs[o].output);
      }
      o = o + 1;
    }
  } catch (e) {
    let broke: WasmRun = { ok: false, output: "",
      error: "the step's input could not be handed over: " + e.message };
    return broke;
  }
  // Checked, not assumed, for the same reason.
  if (!fs.existsSync(callDir + "/prev")) {
    let gone: WasmRun = { ok: false, output: "",
      error: "the step's input could not be written to " + callDir };
    return gone;
  }
  let args: string[] = [];
  args.push("run");
  args.push("-W");
  args.push("timeout=" + `${SCRIPT_TIMEOUT_S}` + "s");
  // The host directory, mounted as the guest's root — the arrangement that
  // works: a preopen at "/" and a RELATIVE read inside the module. Mapping it
  // to a named directory and reading an absolute path answers
  // PermissionDenied, which cost an afternoon to learn.
  args.push("--dir=" + callDir + "::/");
  args.push(wasmPath);
  let res = child_process.spawnSync(wasmtimeBin(), args);
  if (res.status != 0) {
    let why = firstLine(res.stderr);
    if (why == "") { why = firstLine(res.stdout); }
    if (why == "") { why = "the script stopped without saying why"; }
    // The runtime's own words for the two failures a person will actually
    // hit, said the way the rest of this engine says things.
    if (res.stderr.includes("epoch deadline") || res.stderr.includes("interrupt")) {
      why = "the script ran longer than " + `${SCRIPT_TIMEOUT_S}` + " seconds and was stopped";
    } else if (res.stderr.includes("PermissionDenied")) {
      why = "the script tried to reach something it is not given: " + why;
    }
    let failed: WasmRun = { ok: false, output: "", error: why };
    return failed;
  }
  let said = res.stdout;
  if (said.length > SCRIPT_OUT_MAX) {
    let loud: WasmRun = { ok: false, output: "",
      error: "the script answered " + `${said.length}` + " characters — the most a step may pass on is " + `${SCRIPT_OUT_MAX}` };
    return loud;
  }
  let done: WasmRun = { ok: true, output: said.trim(), error: "" };
  return done;
}

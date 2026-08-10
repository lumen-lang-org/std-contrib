import { MAX_SOURCE } from "../workflow/workflow.ts";

export function lumenBin(): string {
  return process.env("AGENTS_LUMEN_BIN") ?? "lumen";
}

export function wasmtimeBin(): string {
  return process.env("AGENTS_WASMTIME_BIN") ?? "wasmtime";
}

export function scriptCacheDir(): string {
  return process.env("AGENTS_SCRIPT_CACHE") ?? "/tmp/joule-script-wasm";
}

export const SCRIPT_TIMEOUT_S: int = 5;
export const SCRIPT_WALL_S: int = 8;
export const SCRIPT_OUT_MAX: int = 262144;

export type ScriptBuild = {
  ok: bool,
  path: string,
  error: string,
  fresh: bool,
};

export type WasmRun = {
  ok: bool,
  output: string,
  error: string,
};

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

export function fullSource(source: string): string {
  return PRELUDE + source;
}

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
  let i: int = 0;
  while (i < text.length) {
    let line = "";
    let j = i;
    while (j < text.length && text.charCodeAt(j) != 10 && text.charCodeAt(j) != 13) {
      line = line + text.charAt(j);
      j = j + 1;
    }
    if (line.trim() != "") {
      return line.trim();
    }
    i = j + 1;
  }
  return "";
}

function preludeLines(): int {
  let n: int = 0;
  let i: int = 0;
  while (i < PRELUDE.length) {
    if (PRELUDE.charCodeAt(i) == 10) {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}

function atUserLine(said: string): string {
  let colon = said.indexOf(":");
  if (colon <= 0) {
    return said;
  }
  let head = said.slice(0, colon);
  let line = parseInt(head, 10) ?? 0;
  if (line <= preludeLines()) {
    return said;
  }
  return `${line - preludeLines()}` + said.slice(colon);
}

function withoutPath(line: string): string {
  let at = line.indexOf(".ts:");
  if (at < 0) {
    return line.trim();
  }
  return atUserLine(line.slice(at + 4).trim());
}

export function compilerSaid(stderr: string, stdout: string): string {
  let text = stderr.trim() == "" ? stdout : stderr;
  let i: int = 0;
  while (i < text.length) {
    let line = "";
    let j = i;
    while (j < text.length && text.charCodeAt(j) != 10) {
      line = line + text.charAt(j);
      j = j + 1;
    }
    if (line.includes("error:")) {
      let said = withoutPath(line);
      return said.length > 300 ? said.slice(0, 297) + "..." : said;
    }
    i = j + 1;
  }
  let one = firstLine(text);
  return one == "" ? "the compiler refused it and said nothing" : one;
}

export function ensureBuilt(source: string): ScriptBuild {
  let hash = scriptHash(source);
  let dir = scriptDir(hash);
  let wasm = scriptWasmPath(hash);
  if (source.trim() == "") {
    let none: ScriptBuild = {
      ok: false,
      path: "",
      error: "there is no script to compile",
      fresh: false,
    };
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
    if (!fs.existsSync(scriptCacheDir())) {
      fs.mkdirSync(scriptCacheDir());
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    fs.writeFileSync(dir + "/" + hash + ".ts", fullSource(source));
  } catch (e) {
    let broke: ScriptBuild = { ok: false, path: "",
      error: "the script could not be written down to compile: " + e.message, fresh: false };
    return broke;
  }
  let res = child_process.spawnSync(lumenBin(), ["compile", "--wasm", dir + "/" + hash + ".ts"]);
  let dropped = hash + ".wasm";
  if (res.status != 0 || !fs.existsSync(dropped)) {
    try { if (fs.existsSync(dropped)) {
      fs.rmSync(dropped, false);
    } } catch { }
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
  sweepCache();
  let made: ScriptBuild = { ok: true, path: wasm, error: "", fresh: true };
  return made;
}

export const SCRIPT_CACHE_KEEP: int = 200;

function sweepCache(): void {
  try {
    let names = fs.readdirSync(scriptCacheDir());
    if (names.length <= SCRIPT_CACHE_KEEP) {
      return;
    }
    let oldestAt: number = 0.0;
    let oldest = "";
    let i: int = 0;
    while (i < names.length) {
      let dir = scriptCacheDir() + "/" + names[i];
      let when = fs.statSync(dir).mtimeMs;
      if (oldest == "" || when < oldestAt) {
        oldestAt = when;
        oldest = dir;
      }
      i = i + 1;
    }
    if (oldest != "") {
      fs.rmSync(oldest, true);
    }
  } catch (e) {
  }
}

export type ScriptGiven = {
  input: string,
  prev: string,
  outputs: ScriptOut[],
};

export type ScriptOut = {
  id: string,
  output: string,
};

function tameId(id: string): bool {
  if (id == "" || id.length > 64) {
    return false;
  }
  let i: int = 0;
  while (i < id.length) {
    let c = id.charAt(i);
    let ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-" || c == "_";
    if (!ok) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function runScript(wasmPath: string, given: ScriptGiven, callDir: string): WasmRun {
  try {
    let cut = callDir.lastIndexOf("/");
    if (cut > 0) {
      let parent = callDir.slice(0, cut);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent);
      }
    }
    if (!fs.existsSync(callDir)) {
      fs.mkdirSync(callDir);
    }
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
  if (!fs.existsSync(callDir + "/prev")) {
    let gone: WasmRun = { ok: false, output: "",
      error: "the step's input could not be written to " + callDir };
    return gone;
  }
  let args: string[] = [];
  args.push("run");
  args.push("-W");
  args.push("timeout=" + `${SCRIPT_TIMEOUT_S}` + "s");
  args.push("--dir=" + callDir + "::/");
  args.push(wasmPath);
  let timed: string[] = [];
  timed.push("-k");
  timed.push("2");
  timed.push(`${SCRIPT_WALL_S}`);
  timed.push(wasmtimeBin());
  let a: int = 0;
  while (a < args.length) {
    timed.push(args[a]);
    a = a + 1;
  }
  let res = child_process.spawnSync("timeout", timed);
  if (res.status != 0) {
    if (res.status == 124 || res.status == 137) {
      let late: WasmRun = { ok: false, output: "",
        error: "the script ran longer than " + `${SCRIPT_WALL_S}` + " seconds and was stopped" };
      return late;
    }
    let why = firstLine(res.stderr);
    if (why == "") {
      why = firstLine(res.stdout);
    }
    if (res.stderr.includes("epoch deadline") || res.stderr.includes("interrupt")) {
      why = "the script ran longer than " + `${SCRIPT_TIMEOUT_S}` + " seconds and was stopped";
    } else if (why == "") {
      why = "the script stopped without saying why";
    } else {
      why = withoutPath(why);
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
  try {
    fs.rmSync(callDir, true);
  } catch (e) { }
  let done: WasmRun = { ok: true, output: said.trim(), error: "" };
  return done;
}

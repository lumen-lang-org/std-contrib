// The claims this module makes are about what a script CANNOT do, so the
// tests are mostly about failures: a network call that has nowhere to go, a
// loop that ends anyway, a path outside the one directory.
//
// These drive the real compiler and the real runtime, so they are slower than
// the rest of the suite and they skip themselves when neither is installed —
// a laptop without wasmtime should report "not here", not "broken".
//
//   cd packages/agents && lumen test script-wasm.test.ts

import { ScriptGiven, ScriptOut, WasmRun, compilerSaid, ensureBuilt, fullSource, runScript, scriptHash, scriptWasmPath, wasmtimeBin } from "./script-wasm.ts";

const DIR = "/tmp/joule-script-test";

function have(): bool {
  let wt = child_process.spawnSync(wasmtimeBin(), ["--version"]);
  return wt.status == 0;
}

function ran(source: string, prev: string): WasmRun {
  let built = ensureBuilt(source);
  if (!built.ok) {
    let refused: WasmRun = { ok: false, output: "", error: built.error };
    return refused;
  }
  let outs: ScriptOut[] = [];
  let one: ScriptOut = { id: "earlier", output: "what the first step said" };
  outs.push(one);
  let given: ScriptGiven = { input: "started with", prev: prev, outputs: outs };
  return runScript(built.path, given, DIR);
}

test("the same source is the same module, and a different one is not", () => {
  let a = scriptHash("console.log(\"one\");");
  let b = scriptHash("console.log(\"one\");");
  let c = scriptHash("console.log(\"two\");");
  expect(a == b);
  expect(a != c);
  expect(a.length == 64);
  expect(scriptWasmPath(a).endsWith("/" + a + "/step.wasm"));
});

test("a compiler refusal is the position and the reason, not a temp path", () => {
  let said = compilerSaid("/tmp/joule-script-wasm/abc/step.ts:3:7: error: unknown name 'wat'\n   3 | wat()\n", "");
  expect(said.startsWith("3:7"));
  expect(said.includes("unknown name"));
  expect(!said.includes("/tmp/"));
});

test("a script computes, and its answer comes back", () => {
  // A test body here is not a function, so a guard is an `if` around the
  // whole of it rather than an early return.
  if (have()) {
  let source = "function main(): void {\n"
    + "  console.log(\"got \" + `${prev().length}` + \" bytes\");\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "hello there");
  expect(out.ok);
  expect(out.output.startsWith("got 11 bytes"));
  }
});

test("a second run of the same source does not compile again", () => {
  if (have()) {
  let source = "function main(): void { console.log(\"steady\"); }\nmain();\n";
  let first = ensureBuilt(source);
  expect(first.ok);
  let again = ensureBuilt(source);
  expect(again.ok);
  expect(!again.fresh);
  expect(again.path == first.path);
  }
});

test("a script cannot reach the network — the instruction is not in the module", () => {
  if (have()) {
  // This COMPILES: http.request is a real function and the type checker is
  // happy. It is the wasm target that has no socket to call, so the refusal
  // arrives at run time, which is the honest place for it — the module is
  // what carries the guarantee, not our reading of the source.
  let source = "function main(): void {\n"
    + "  let h = new Map<string, string>();\n"
    + "  let res = http.request(\"https://example.com\", \"GET\", \"\", h);\n"
    + "  console.log(`${res.status}`);\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "{}");
  // Either it refuses to build for this target or it fails when it tries;
  // what must never happen is a 200.
  expect(!out.ok || !out.output.includes("200"));
  }
});

test("a script reads the walk with the same words the templates use", () => {
  if (have()) {
  // {{prev}}, {{input}} and {{node.<id>}} in a field; prev(), input() and
  // node("<id>") here. The prelude is what makes the two agree.
  let source = "function main(): void {\n"
    + "  console.log(prev() + \"|\" + input() + \"|\" + node(\"earlier\"));\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "the last answer");
  expect(out.ok);
  expect(out.output == "the last answer|started with|what the first step said");
  }
});

test("a step that is not there reads as nothing, not as a failure", () => {
  if (have()) {
  let source = "function main(): void {\n"
    + "  console.log(\"[\" + node(\"nobody\") + \"]\");\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "x");
  expect(out.ok);
  expect(out.output == "[]");
  }
});

test("the prelude is part of what is hashed", () => {
  // Change what a script is handed and every module must be built again — a
  // hash of the body alone would not notice.
  expect(fullSource("main();").includes("function prev()"));
  expect(fullSource("main();").endsWith("main();"));
});

test("a script that will not stop is stopped", () => {
  if (have()) {
  let source = "function main(): void {\n"
    + "  let n: int = 0;\n"
    + "  while (true) { n = n + 1; }\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "{}");
  expect(!out.ok);
  expect(out.error.includes("longer than") || out.error.includes("stopped"));
  }
});

test("a script sees the one directory it is given and nothing beside it", () => {
  if (have()) {
  let source = "function main(): void {\n"
    + "  let secret = fs.readFileSync(\"/etc/hostname\");\n"
    + "  console.log(\"read \" + `${secret.length}`);\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "{}");
  expect(!out.ok);
  }
});

test("a guest's own diagnostic is what is reported, minus the cache path", () => {
  if (have()) {
  // The message is on stderr under a blank line, which the first version of
  // firstLine answered with "" — so every guest failure read as "stopped
  // without saying why" while the reason sat one line further down.
  let source = "function main(): void {\n"
    + "  let s = fs.readFileSync(\"no-such-file\");\n"
    + "  console.log(s);\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "x");
  expect(!out.ok);
  expect(out.error.includes("cannot read 'no-such-file'"));
  expect(!out.error.includes("/tmp/"));
  expect(!out.error.includes("stopped without saying why"));
  }
});

test("a network attempt ends at once — there is no socket to wait on", () => {
  if (have()) {
  let source = "function main(): void {\n"
    + "  let h = new Map<string, string>();\n"
    + "  let r = http.request(\"https://example.com\", \"GET\", \"\", h);\n"
    + "  console.log(`${r.status}`);\n"
    + "}\n"
    + "main();\n";
  // Built first, then timed: a step's duration includes its compile the
  // first time, and that is what a twenty-five second "network attempt" in
  // an early measurement actually was — a fresh build, not a runaway.
  let built = ensureBuilt(source);
  expect(built.ok);
  let began = Date.now() as number;
  let out = ran(source, "x");
  let took = (Date.now() as number) - began;
  expect(took < 5000.0);
  // It answers -1: the module has no socket call in it, so the request
  // cannot leave. `timeout` in front of the runtime is the belt for a host
  // call that DOES block, which the epoch budget cannot interrupt.
  expect(out.ok);
  expect(out.output.includes("-1"));
  }
});

test("a diagnostic points at the line the person wrote", () => {
  if (have()) {
  // The prelude sits above their text, so the compiler counts from ITS top:
  // an error on line 2 of a script was reported at line 15, and the reader
  // counted down through code they never wrote.
  let source = "function main(): void {\n"
    + "  let x: int = \"not an int\";\n"
    + "  console.log(x);\n"
    + "}\n"
    + "main();\n";
  let built = ensureBuilt(source);
  expect(!built.ok);
  expect(built.error.startsWith("2:"));
  }
});

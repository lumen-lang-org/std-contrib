// The claims this module makes are about what a script CANNOT do, so the
// tests are mostly about failures: a network call that has nowhere to go, a
// loop that ends anyway, a path outside the one directory.
//
// These drive the real compiler and the real runtime, so they are slower than
// the rest of the suite and they skip themselves when neither is installed —
// a laptop without wasmtime should report "not here", not "broken".
//
//   cd packages/agents && lumen test script-wasm.test.ts

import { WasmRun, compilerSaid, ensureBuilt, runScript, scriptHash, scriptWasmPath, wasmtimeBin } from "./script-wasm.ts";

const DIR = "/tmp/joule-script-test";

function have(): bool {
  let wt = child_process.spawnSync(wasmtimeBin(), ["--version"]);
  return wt.status == 0;
}

function ran(source: string, input: string): WasmRun {
  let built = ensureBuilt(source);
  if (!built.ok) {
    let refused: WasmRun = { ok: false, output: "", error: built.error };
    return refused;
  }
  return runScript(built.path, input, DIR);
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
    + "  let given = fs.readFileSync(\"input.json\");\n"
    + "  console.log(\"got \" + `${given.length}` + \" bytes\");\n"
    + "}\n"
    + "main();\n";
  let out = ran(source, "{\"prev\":\"hello\"}");
  expect(out.ok);
  expect(out.output.startsWith("got 16 bytes"));
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

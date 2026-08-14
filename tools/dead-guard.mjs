// Find a caller that guards on a sentinel its callee can never return.
//
// The shape that motivated this, fixed in 0d824b0: template.service.ts wrote
//   let made = this.repository.startThread(...);
//   if (made == "") { return refusing("the conversation could not be started"); }
// while startThread ended `persist(...); return id;` and so never returned "".
// The guard read as care and was dead code; a failed write walked straight past
// it. The same shape hides anywhere a function's failure value is a convention
// rather than something the compiler checks.
//
// Reports candidates only. Whether a sentinel is reachable is a judgement about
// the callee's whole body, and this tool deliberately does not make it.
//
// Run against the tree as it stands it reports three, and all three are false
// positives — worth knowing before spending an afternoon on them again:
//
//   document.service.ts:54   embeddingId returns embeddingModel(...).id, and the
//                            absent row it falls back to carries id: "". The
//                            field access off a returned struct is the blind
//                            spot; following the call is not enough.
//   threads.ts:966, :1132    cleanTitle returns `text`, which it reassigns from
//                            an accumulator that starts "" and stays "" when the
//                            model answered only whitespace. Assignment chains
//                            through an intermediate are not followed.
//
// Both shapes could be taught, at the cost of a real dataflow pass. Three known
// false positives against a sweep that already found its one true instance did
// not seem worth that, but the next person to touch this should know why it
// stops where it does rather than assume nobody noticed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = "/home/ubuntu/projects/std-contrib/packages/agents";

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
      continue;
    }
    if (extname(full) !== ".ts") continue;
    if (name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = sources(ROOT);

// Every function/method body in the package, by name. A method and a free
// function of the same name collide here; the report names the file so a
// human can tell them apart.
const bodies = new Map();
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:function\s+)?([a-zA-Z_][\w]*)\s*\([^)]*\)\s*:\s*([\w<>\[\]]+)\s*\{/);
    if (!m) continue;
    const [, name, returns] = m;
    if (["if", "while", "for", "switch", "catch", "return"].includes(name)) continue;
    // Take the body by brace depth from this line.
    let depth = 0, started = false, body = [];
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      body.push(lines[j]);
      if (started && depth <= 0) break;
    }
    if (!bodies.has(name)) bodies.set(name, []);
    bodies.get(name).push({ file, line: i + 1, returns, body: body.join("\n") });
  }
}

// Whether the callee can answer "" at all.
//
// The first cut of this asked whether the body contained `return <identifier>;`
// and treated that as "yes". That is exactly backwards: the bug this tool
// exists to find ends `persist(...); return id;`, so the first cut would have
// skipped its own worked example. A detector that misses the instance it was
// modelled on is worse than none, because it reads as coverage.
//
// What actually shows "" is reachable:
//   - a return whose expression mentions "" at all — `return "";`,
//     `return x ?? "";`, `return ok ? a : "";`
//   - a return of a name that is assigned "" somewhere in the body, which is
//     the `let out = ""; ... return out;` accumulator shape
// Reads that answer "" for a rowNAME that is not there. A wrapper returning one
// of these straight through is a live guard, not a dead one.
const EMPTY_ON_MISS = new Set(["findById", "jsonText", "jsonRaw", "credentialFor", "env"]);

// A comment inside a function body is not code, and this codebase writes
// prose comments freely — "this one does not return "" on failure" is
// exactly the sentence that would fool a line-scan for `return ... ""`, and
// it says the opposite of what it would be read as. Confirmed live: a
// planted comment saying a function does NOT return "" made canAnswerEmpty
// report that it could, hiding the caller's guard as live when the function
// underneath, code only, never returns "". Same class of bug fixed in
// narrow-write.mjs and narrow-read.mjs the cycle before this one, just
// pointed the other way — there a phantom comment field created a false
// finding, here a phantom comment sentence erases a real one, which is
// worse: it is a false negative in a tool whose whole job is not missing
// its own worked example.
function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function canAnswerEmpty(entry, depth = 0) {
  const body = stripComments(entry.body);
  for (const line of body.split("\n")) {
    if (/return[^;]*""/.test(line)) return true;
  }
  const named = [...body.matchAll(/return\s+([a-zA-Z_][\w]*)\s*;/g)].map(m => m[1]);
  for (const name of named) {
    if (new RegExp(`(?:let\\s+)?${name}(?:\\s*:\\s*string)?\\s*=\\s*""`).test(body)) return true;
  }
  // A pass-through — `return openThread(...)`, `return findById(...)`. The
  // question is really about whatever it forwards to, so follow it. Two hops is
  // enough for the repository/service wrappers this codebase actually writes,
  // and the depth cap keeps a recursive pair from spinning.
  if (depth >= 2) return true;
  for (const m of body.matchAll(/return\s+(?:[a-zA-Z_][\w]*\.)*([a-zA-Z_][\w]*)\s*\(/g)) {
    const forwarded = m[1];
    if (EMPTY_ON_MISS.has(forwarded)) return true;
    const next = bodies.get(forwarded);
    if (!next) return true; // not ours to see — assume it can, and stay quiet
    if (next.some(d => canAnswerEmpty(d, depth + 1))) return true;
  }
  return false;
}

const findings = [];
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // let x = something(...);   then   if (x == "")
    const call = lines[i].match(/^\s*let\s+([a-zA-Z_][\w]*)\s*=\s*(?:this\.[\w.]*\.)?([a-zA-Z_][\w]*)\s*\(/);
    if (!call) continue;
    const [, variable, callee] = call;
    const near = lines.slice(i + 1, i + 4).join("\n");
    const guard = near.match(new RegExp(`if\\s*\\(\\s*${variable}\\s*==\\s*""\\s*\\)`));
    if (!guard) continue;

    const defined = bodies.get(callee);
    if (!defined || defined.length === 0) continue; // not ours, or a builtin
    // Only string-returning callees can answer "".
    const stringy = defined.filter(d => d.returns === "string");
    if (stringy.length === 0) continue;
    const canAnswer = stringy.some(canAnswerEmpty);
    if (canAnswer) continue;

    findings.push({
      file: file.replace(ROOT + "/", ""),
      line: i + 1,
      variable,
      callee,
      where: stringy.map(d => d.file.replace(ROOT + "/", "") + ":" + d.line),
      guard: lines[i + 1].trim(),
    });
  }
}

if (findings.length === 0) {
  console.log("no dead-guard candidates");
} else {
  console.log(`${findings.length} candidate(s) — a guard on "" whose callee may never answer "":\n`);
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  let ${f.variable} = ${f.callee}(...)`);
    console.log(`    guard:  ${f.guard}`);
    console.log(`    callee: ${f.where.join(", ")}`);
    console.log();
  }
}

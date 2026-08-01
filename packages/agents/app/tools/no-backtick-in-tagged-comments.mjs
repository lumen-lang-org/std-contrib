// A backtick inside a comment inside a css`` or html`` literal ends the
// literal. The rest of the file then parses as whatever it happens to look
// like, and the error lands wherever that stops making sense — five lines
// below, in the middle of a rule nobody touched, saying `Expected ";"`.
//
// This has now been shipped four times in this package, once far enough to
// reach a docker build and take the console down for a minute. Every time the
// fix took seconds and the diagnosis took ten minutes, because the reported
// line is not the line with the mistake. That ratio is the whole argument for
// a check: it is not that the error is hard to fix, it is that the error does
// not say what it is.
//
// Deliberately not a lint rule or a plugin. It is thirty lines of scanning,
// it needs no config, and it runs before the build in one npm script — a
// rule in a linter someone has to install and enable would be a fifth way to
// forget.
//
//   node tools/no-backtick-in-tagged-comments.mjs src
//
// Exit 1 and a file:line on the first offence.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every .ts file under a directory, recursively. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Walk the file once, tracking whether we are inside a tagged template and
// whether we are inside a comment within it. Not a parser: a tagged template
// here is `css` or `html` immediately before a backtick, which is how every
// one of them is written in this package, and the failure mode of guessing
// wrong is a false positive that a human reads in one second.
function offences(text) {
  const found = [];
  let line = 1;
  let inTemplate = false;
  let inComment = ""; // "" | "block" | "html"
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (!inTemplate) {
      if (c === "`") {
        const before = text.slice(Math.max(0, i - 5), i);
        if (/(^|[^A-Za-z0-9_$])(css|html|svg)$/.test(before)) inTemplate = true;
      }
      continue;
    }
    if (inComment === "") {
      if (c === "/" && text[i + 1] === "*") { inComment = "block"; i++; continue; }
      if (text.startsWith("<!--", i)) { inComment = "html"; i += 3; continue; }
      // A backtick outside a comment is the literal ending, which is correct.
      if (c === "`") inTemplate = false;
      continue;
    }
    if (c === "`") {
      found.push({ line, kind: inComment });
      // Keep going: the literal is now mis-parsed anyway, and reporting every
      // offence in one run beats making somebody re-run per backtick.
    }
    if (inComment === "block" && c === "*" && text[i + 1] === "/") { inComment = ""; i++; }
    if (inComment === "html" && text.startsWith("-->", i)) { inComment = ""; i += 2; }
  }
  return found;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/no-backtick-in-tagged-comments.mjs <dir...>");
  process.exit(2);
}

let bad = 0;
for (const root of roots) {
  for (const file of sources(root)) {
    for (const { line, kind } of offences(readFileSync(file, "utf8"))) {
      console.error(
        `${file}:${line}  backtick inside a ${kind} comment in a tagged template — ` +
        `it ends the literal. Write the code plainly instead.`);
      bad++;
    }
  }
}
if (bad > 0) {
  console.error(`\n${bad} backtick${bad === 1 ? "" : "s"} that would break the build.`);
  process.exit(1);
}
console.log("no backticks in tagged-template comments");

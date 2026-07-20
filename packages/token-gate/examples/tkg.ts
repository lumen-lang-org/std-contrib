// tkg — the token-gate CLI: run a command, filter its output for AI context.
//
// Per-command handlers:
//   git status   -> branch line + change groups
//   git log      -> `shorthash subject` per commit
//   git diff     -> diffstat only (+ hint for full detail)
//   ls           -> names + sizes, columns dropped
//   find         -> paths grouped by top directory
//   du           -> largest entries first, top 20
//   grep/rg      -> max 3 matches per file
//   ps/docker/kubectl -> table header + capped rows
//   tsc/eslint/cargo build/ruff/mypy -> errors + warnings only
//   test runners -> failures + summary only (zig/cargo/npm/go/pytest/jest)
//   anything else-> ANSI-strip + dedupe + head/tail truncation
//
// Also:
//   tkg gain     -> total bytes saved so far (from the ~/.tkg-log ledger)
//
// Build: lumen compile --release-fast packages/token-gate/examples/tkg.ts
// Usage: tkg <command> [args...]

import { stripAnsi, dedupe, truncate, groupGitStatus, splitLines, lsSummary, compactLog, capGrep, filterTestOutput, groupByDir, topBySize, errorLines, tableHead } from "../token-gate.ts";

function logPath(): string {
  return (process.env.HOME ?? ".") + "/.tkg-log";
}

// Emit filtered lines, record `rawBytes outBytes` to the ledger, exit.
function emit(rawBytes: int, out: string[], status: int): void {
  let outBytes = 0;
  for (const l of out) {
    console.log(l);
    outBytes = outBytes + l.length + 1;
  }
  try {
    fs.appendFileSync(logPath(), rawBytes + " " + outBytes + "\n");
  } catch (e) {
    // ledger is best-effort; never fail the wrapped command over it.
  }
  process.exit(status);
}

// `tkg gain`: sum the ledger into a human savings report.
function gain(): void {
  let raw = 0;
  let out = 0;
  let calls = 0;
  try {
    const text = fs.readFileSync(logPath());
    for (const line of splitLines(text)) {
      const parts = line.split(" ");
      if (parts.length < 2) continue;
      raw = raw + (parseInt(parts[0]) ?? 0);
      out = out + (parseInt(parts[1]) ?? 0);
      calls = calls + 1;
    }
  } catch (e) {
    console.log("no ledger yet — run some commands through tkg first");
    process.exit(0);
  }
  const saved = raw - out;
  const pct = raw > 0 ? ((saved * 100) / raw) : 0;
  // ~4 bytes per token is the usual rough conversion.
  const tokens = saved / 4;
  console.log("calls:  " + calls);
  console.log("raw:    " + raw + " bytes");
  console.log("out:    " + out + " bytes");
  console.log("saved:  " + saved + " bytes (" + pct.toFixed(1) + "%), ~" + tokens.toFixed(0) + " tokens");
  process.exit(0);
}

function runCombined(cmd: string, args: string[]): string {
  const res = child_process.spawnSync(cmd, args);
  return stripAnsi(res.stdout) + (res.stderr.length > 0 ? "\n" + stripAnsi(res.stderr) : "");
}

function main(): void {
  const argv = process.argv;
  if (argv.length < 2) {
    console.log("usage: tkg <command> [args...]   |   tkg gain");
    process.exit(2);
  }
  const cmd = argv[1];
  if (cmd === "gain") gain();

  const args = argv.slice(2);
  const sub = args.length > 0 ? args[0] : "";

  if (cmd === "git" && sub === "status") {
    const sb = child_process.spawnSync("git", ["status", "-sb"]);
    const bare = child_process.spawnSync("git", ["status"]);
    const p = child_process.spawnSync("git", ["status", "--porcelain"]);
    const sbLines = splitLines(stripAnsi(sb.stdout));
    let out: string[] = [];
    if (sbLines.length > 0) out.push(sbLines[0]);
    for (const l of groupGitStatus(splitLines(p.stdout))) out.push(l);
    emit(bare.stdout.length, out, p.status);
  }

  if (cmd === "git" && sub === "log") {
    const res = child_process.spawnSync("git", args);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, truncate(compactLog(splitLines(raw)), 40), res.status);
  }

  if (cmd === "git" && (sub === "diff" || sub === "show")) {
    const bare = child_process.spawnSync("git", args);
    let statArgs: string[] = [];
    for (const a of args) statArgs.push(a);
    statArgs.push("--stat");
    const res = child_process.spawnSync("git", statArgs);
    let out = truncate(splitLines(stripAnsi(res.stdout)), 40);
    out.push("[diffstat only — run plain `git " + sub + " <path>` for hunks]");
    emit(bare.stdout.length, out, res.status);
  }

  if (cmd === "ls") {
    let lsArgs: string[] = ["-la"];
    for (const a of args) {
      if (a !== "-l" && a !== "-la" && a !== "-al" && a !== "-a") lsArgs.push(a);
    }
    const res = child_process.spawnSync("ls", lsArgs);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, truncate(lsSummary(splitLines(raw)), 60), res.status);
  }

  if (cmd === "find") {
    const res = child_process.spawnSync("find", args);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, truncate(groupByDir(splitLines(raw)), 60), res.status);
  }

  if (cmd === "du") {
    const res = child_process.spawnSync("du", args);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, topBySize(splitLines(raw), 20), res.status);
  }

  if (cmd === "grep" || cmd === "rg") {
    const res = child_process.spawnSync(cmd, args);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, truncate(capGrep(splitLines(raw)), 60), res.status);
  }

  const isTable =
    (cmd === "docker" && (sub === "ps" || sub === "images")) ||
    (cmd === "kubectl" && sub === "get") ||
    cmd === "ps";
  if (isTable) {
    const res = child_process.spawnSync(cmd, args);
    const raw = stripAnsi(res.stdout);
    emit(raw.length, tableHead(splitLines(raw), 25), res.status);
  }

  const isLint =
    cmd === "tsc" || cmd === "eslint" ||
    (cmd === "npx" && (sub === "tsc" || sub === "eslint")) ||
    (cmd === "cargo" && (sub === "build" || sub === "check" || sub === "clippy")) ||
    cmd === "ruff" || cmd === "mypy";
  if (isLint) {
    const raw = runCombined(cmd, args);
    const res = child_process.spawnSync(cmd, args);
    let out = errorLines(splitLines(raw));
    out.push(res.status === 0 ? "[clean]" : "[FAILED, exit " + res.status + "]");
    emit(raw.length, out, res.status);
  }

  const isTest =
    (cmd === "zig" && sub === "build") ||
    (cmd === "cargo" && sub === "test") ||
    (cmd === "npm" && sub === "test") ||
    (cmd === "go" && sub === "test") ||
    cmd === "pytest" || cmd === "jest";
  if (isTest) {
    const res = child_process.spawnSync(cmd, args);
    const raw = stripAnsi(res.stdout) + "\n" + stripAnsi(res.stderr);
    let out = filterTestOutput(splitLines(raw));
    out.push(res.status === 0 ? "[tests ok]" : "[tests FAILED, exit " + res.status + "]");
    emit(raw.length, out, res.status);
  }

  const res = child_process.spawnSync(cmd, args);
  const raw = stripAnsi(res.stdout) + (res.stderr.length > 0 ? "\n" + stripAnsi(res.stderr) : "");
  let out = truncate(dedupe(splitLines(raw)), 40);
  if (res.status !== 0) out.push("[exit " + res.status + "]");
  emit(raw.length, out, res.status);
}

main();

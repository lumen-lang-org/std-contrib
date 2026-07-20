// tkg — the token-gate CLI: run a command, filter its output for AI context.
//
// Per-command handlers (rtk-style richness):
//   git status   -> branch line + change groups
//   git log      -> `shorthash subject` per commit
//   git diff     -> diffstat only (+ hint for full detail)
//   ls           -> names + sizes, columns dropped
//   grep/rg      -> max 3 matches per file
//   test runners -> failures + summary only (zig/cargo/npm/pytest/go)
//   anything else-> ANSI-strip + dedupe + head/tail truncation
//
// Build: lumen compile packages/token-gate/examples/tkg.ts
// Usage: tkg <command> [args...]

import { stripAnsi, dedupe, truncate, groupGitStatus, splitLines, lsSummary, compactLog, capGrep, filterTestOutput } from "../token-gate.ts";

function print(lines: string[]): void {
  for (const l of lines) console.log(l);
}

function main(): void {
  const argv = process.argv;
  if (argv.length < 2) {
    console.log("usage: tkg <command> [args...]");
    process.exit(2);
  }
  const cmd = argv[1];
  const args = argv.slice(2);
  const sub = args.length > 0 ? args[0] : "";

  if (cmd === "git" && sub === "status") {
    // Branch + ahead/behind from -sb line 1, then grouped porcelain.
    const sb = child_process.spawnSync("git", ["status", "-sb"]);
    const sbLines = splitLines(stripAnsi(sb.stdout));
    if (sbLines.length > 0) console.log(sbLines[0]);
    const p = child_process.spawnSync("git", ["status", "--porcelain"]);
    print(groupGitStatus(splitLines(p.stdout)));
    process.exit(p.status);
  }

  if (cmd === "git" && sub === "log") {
    const res = child_process.spawnSync("git", args);
    print(truncate(compactLog(splitLines(stripAnsi(res.stdout))), 40));
    process.exit(res.status);
  }

  if (cmd === "git" && (sub === "diff" || sub === "show")) {
    // Diffstat is the token-efficient shape; full patches on request only.
    let statArgs: string[] = [];
    for (const a of args) statArgs.push(a);
    statArgs.push("--stat");
    const res = child_process.spawnSync("git", statArgs);
    print(truncate(splitLines(stripAnsi(res.stdout)), 40));
    console.log("[diffstat only — run plain `git " + sub + " <path>` for hunks]");
    process.exit(res.status);
  }

  if (cmd === "ls") {
    // Force -la so sizes/dirs are known, then compact the columns away.
    let lsArgs: string[] = ["-la"];
    for (const a of args) {
      if (a !== "-l" && a !== "-la" && a !== "-al" && a !== "-a") lsArgs.push(a);
    }
    const res = child_process.spawnSync("ls", lsArgs);
    print(truncate(lsSummary(splitLines(stripAnsi(res.stdout))), 60));
    process.exit(res.status);
  }

  if (cmd === "grep" || cmd === "rg") {
    const res = child_process.spawnSync(cmd, args);
    print(truncate(capGrep(splitLines(stripAnsi(res.stdout))), 60));
    process.exit(res.status);
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
    print(filterTestOutput(splitLines(raw)));
    console.log(res.status === 0 ? "[tests ok]" : "[tests FAILED, exit " + res.status + "]");
    process.exit(res.status);
  }

  const res = child_process.spawnSync(cmd, args);
  const raw = stripAnsi(res.stdout) + (res.stderr.length > 0 ? "\n" + stripAnsi(res.stderr) : "");
  print(truncate(dedupe(splitLines(raw)), 40));
  if (res.status !== 0) console.log("[exit " + res.status + "]");
  process.exit(res.status);
}

main();

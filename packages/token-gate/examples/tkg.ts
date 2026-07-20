// tkg — the token-gate CLI: run a command, filter its output.
//
// Build: lumen compile packages/token-gate/examples/tkg.ts
// Usage: tkg <command> [args...]

import { stripAnsi, dedupe, truncate, groupGitStatus, splitLines } from "../token-gate.ts";

function main(): void {
  const argv = process.argv;
  if (argv.length < 2) {
    console.log("usage: tkg <command> [args...]");
    process.exit(2);
  }
  const cmd = argv[1];
  const args = argv.slice(2);

  // git status: replace porcelain detail with a grouped summary.
  if (cmd === "git" && args.length > 0 && args[0] === "status") {
    const p = child_process.spawnSync("git", ["status", "--porcelain"]);
    for (const l of groupGitStatus(splitLines(p.stdout))) console.log(l);
    process.exit(p.status);
  }

  const res = child_process.spawnSync(cmd, args);
  const raw = stripAnsi(res.stdout) + (res.stderr.length > 0 ? "\n" + stripAnsi(res.stderr) : "");
  const cleaned = truncate(dedupe(splitLines(raw)), 40);
  for (const l of cleaned) console.log(l);
  if (res.status !== 0) console.log("[exit " + res.status + "]");
  process.exit(res.status);
}

main();

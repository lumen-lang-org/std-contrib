import { envSyncIgnored, envSyncIgnoredBy, envSyncRulesFrom, envSyncFindCmd, envSyncSkips } from "./env-sync.ts";

// The two pure halves of the sync, which are the halves worth being sure of:
// what is a record and what is regenerable, and a find that does not descend
// into a hundred thousand files to answer that nothing changed.

test("what a machine can regenerate is not a record", () => {
  expect(envSyncIgnored("./node_modules/react/index.js"));
  expect(envSyncIgnored("node_modules/react/index.js"));
  // A monorepo has one per package, so the name counts at any depth.
  expect(envSyncIgnored("packages/video/node_modules/remotion/x.js"));
  expect(envSyncIgnored("./dist/bundle.js"));
  expect(envSyncIgnored("./.git/HEAD"));
  expect(envSyncIgnored("./.vite/deps/chunk.js"));
  expect(envSyncIgnored("./src/debug.log"));
  expect(envSyncIgnored("./.DS_Store"));
  expect(envSyncIgnored(""));
});

test("what a person wrote is", () => {
  expect(!envSyncIgnored("./src/Commercial.tsx"));
  expect(!envSyncIgnored("package.json"));
  expect(!envSyncIgnored("./public/logo.png"));
  expect(!envSyncIgnored("./src/scenes/EndCard.tsx"));
  // Near-misses that must not be swept up with the skips.
  expect(!envSyncIgnored("./src/build.ts"));
  expect(!envSyncIgnored("./distribution/notes.md"));
  expect(!envSyncIgnored("./logbook.md"));
});

test("the find prunes before it descends, and asks only for what is newer", () => {
  let cmd = envSyncFindCmd("1700000000");

  expect(cmd.indexOf("-prune") > 0);
  // The prune has to come before -type f, or find walks node_modules anyway.
  expect(cmd.indexOf("-prune") < cmd.indexOf("-type f"));
  expect(cmd.indexOf("-name 'node_modules'") > 0);
  expect(cmd.indexOf("-newermt '@1700000000'") > 0);
  expect(cmd.indexOf("cd /workspace") == 0);

  // A first sweep has no stamp and wants everything.
  let all = envSyncFindCmd("");
  expect(all.indexOf("-newermt") < 0);
  expect(envSyncFindCmd("0").indexOf("-newermt") < 0);
  expect(envSyncSkips().length > 10);
});

test("the project's own ignore file is read, and read conservatively", () => {
  let rules = envSyncRulesFrom([
    "# comments and blanks are not rules",
    "",
    "out/",
    "/coverage",
    "*.tmp",
    "secrets.json",
    "!keep-me.tmp",
    "src/generated/*.ts",
  ].join("\n"));

  expect(rules.length == 4);
  // A trailing slash is a directory and a leading one anchors: this matches on
  // whole segments either way, so both are stripped.
  expect(rules.indexOf("out") >= 0);
  expect(rules.indexOf("coverage") >= 0);
  expect(rules.indexOf("*.tmp") >= 0);
  expect(rules.indexOf("secrets.json") >= 0);
  // A negation and a path pattern are rules this cannot read, so it does not
  // act on them: guessing wide is how somebody's file is silently dropped.
  expect(rules.indexOf("keep-me.tmp") < 0);
  expect(rules.indexOf("src/generated/*.ts") < 0);
});

test("a project's rules sit on top of the floor, never under it", () => {
  let rules = envSyncRulesFrom("secrets.json\n*.tmp\nout/\n");

  expect(envSyncIgnoredBy("./secrets.json", rules));
  expect(envSyncIgnoredBy("./config/secrets.json", rules));
  expect(envSyncIgnoredBy("./src/scratch.tmp", rules));
  expect(envSyncIgnoredBy("./out/main.js", rules));

  // The floor holds whatever the project says, and a project that ignores
  // nothing still does not carry node_modules back.
  let none: string[] = [];
  expect(envSyncIgnoredBy("./node_modules/react/index.js", none));
  expect(!envSyncIgnoredBy("./src/Commercial.tsx", rules));
  expect(!envSyncIgnoredBy("./src/tmp.ts", rules));
});

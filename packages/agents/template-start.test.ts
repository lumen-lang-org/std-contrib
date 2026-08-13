import { templateStartCmd } from "./routes/templates/template.utils.ts";

test("a starting point runs one command, and generates itself only once", () => {
  let both = templateStartCmd("npm create vite@latest . -- --template react-ts", "npm run dev");

  expect(both.indexOf("cd /workspace") > 0);
  // A bootstrap that fails must not be followed by a serve on top of half a
  // project: the lines are held together by set -e, not by &&.
  expect(both.indexOf("set -e") == 0);
  // The guard is what makes it idempotent: a container wiped and rebuilt
  // generates the project again, one that already holds it does not.
  expect(both.indexOf("if [ ! -f package.json ]") > 0);
  expect(both.indexOf("npm create vite") > 0);
  expect(both.indexOf("npm run dev") > both.indexOf("npm create vite"));

  // A heredoc's terminator has to be alone on its line, which is why nothing
  // is appended to the bootstrap's last line. This is the whole reason for the
  // shape, and it is the bug that left a React app with an unparseable
  // vite.config.ts and no server at all.
  let wrote = templateStartCmd("cat > c.ts <<'EOF'\nexport default 1;\nEOF", "npm run dev");
  expect(wrote.indexOf("\nEOF\nfi\n") > 0);

  // The state a fork arrives in: files but no node_modules, because
  // node_modules is not an artifact. Without this the serve runs against a
  // project with no vite in it and the panel never loads.
  expect(both.indexOf("[ ! -d node_modules ]") > 0);
  expect(both.indexOf("npm install") < both.indexOf("npm run dev"));
  // And it is skipped where there is no node project to install for.
  expect(both.indexOf("[ -f package.json ] && [ ! -d node_modules ]") > 0);

  // Nothing to generate is a legal starting point: an image that already
  // carries the project only needs serving.
  let plain = templateStartCmd("", "npm start");
  expect(plain.indexOf("set -e\ncd /workspace\n") == 0);
  expect(plain.indexOf("npm start") > 0);
  expect(plain.indexOf("if [ ! -f package.json ]") < 0);

  // Nothing to serve is not a starting point at all.
  expect(templateStartCmd("npm install", "") == "");
});

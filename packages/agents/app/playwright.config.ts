import { defineConfig } from "@playwright/test";
import { PORT, PREVIEW_HOST, PREVIEW_HOSTNAME } from "./e2e/deployment.js";

// The artifacts host, as this run understands it — read in e2e/deployment.ts,
// which the specs share, so the name the console is told to answer to and the
// name a spec navigates to are one value.
//
// preview-live.spec.ts navigates to it, and the console has to answer there:
// the default bind is loopback (lumenjs.plugins.js) and Vite refuses a Host it
// was not told about, so a dev server started without these two answers
// `ERR_CONNECTION_REFUSED` or "Blocked request" to every preview assertion —
// which reads as a broken preview rather than as a server that was never asked
// to serve that name.
//
// The bind widens to every interface only for a suite that names a host off
// loopback, and only for the server this file starts and stops. A run that
// leaves AGENTS_PREVIEW_HOST alone gets the historical default, which is an
// address on this machine; a run against a deployment sets it to that
// deployment's host and the engine must agree, port included.
const CONSOLE_ENV = {
  AGENTS_PREVIEW_HOST: PREVIEW_HOST,
  AGENTS_CONSOLE_BIND:
    process.env.AGENTS_CONSOLE_BIND ??
    (/^(localhost|127\.0\.0\.1)$/.test(PREVIEW_HOSTNAME) ? "127.0.0.1" : "0.0.0.0"),
};

// The two stand-ins the engine calls out to. Started for every run, including
// one pointed at a console it did not start: they are the *engine's*
// dependencies, not the console's, and the engine in a `CONSOLE_URL` run is
// still the one on this machine. Starting only the MCP double there — which is
// what this list did — left the model double down, so every spec that drives a
// scripted answer failed against a console that was working perfectly.
const DOUBLES = [
  {
    // The graph draws what a server says it offers, so with nothing answering,
    // the tool nodes could only ever be tested as absent.
    command: "node e2e/mcp-double.mjs",
    url: "http://127.0.0.1:8931/mcp",
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 20_000,
  },
  {
    // A canned chat model, so extraction is tested against a real model
    // round-trip instead of only unit-tested behind the API.
    command: "node e2e/model-double.mjs",
    url: "http://127.0.0.1:8932",
    reuseExistingServer: true,
    timeout: 20_000,
  },
];

// The console under test needs a running API. These specs do not start one —
// they check what a deployment does, and a suite that boots its own fake would
// be checking the fake. Point AGENTS_API at a live server (the compose stack,
// or ./api against PostgreSQL) and run:
//
//   npx playwright test
//
// Against sqlite the knowledge specs skip themselves rather than fail: the
// API answers "documents need PostgreSQL (pgvector)" and that is correct
// behaviour, not a broken test.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CONSOLE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A recording per test, so a reviewer can watch what was actually checked
    // rather than read an assertion and take it on trust.
    video: { mode: "on", size: { width: 1280, height: 800 } },
    // Wider than the console's one breakpoint, which is 1024 (src/console.ts).
    //
    // Not a detail: below it the rail stops being a column and becomes a
    // drawer that is summoned from the chat header — and the knowledge page
    // and the agent graph replace that header entirely, so at a narrow width
    // there is no way back to the rail from either of them. The suite ran at
    // 1000px, twenty-four pixels the wrong side of a line drawn after it was
    // written, and every spec that opens Settings or Knowledge was therefore
    // clicking a rail parked off-canvas.
    //
    // The helpers summon the drawer where there is one (`openRail` in
    // e2e/console.ts), so nothing here depends on the width. What this chooses
    // is which of the two layouts the suite spends its time in, and it is the
    // one the console is designed around and the one these tests describe.
    viewport: { width: 1280, height: 800 },
  },
  webServer: process.env.CONSOLE_URL
    ? DOUBLES
    : [
        {
          command: `npx lumenjs dev --port ${PORT}`,
          url: `http://127.0.0.1:${PORT}`,
          env: CONSOLE_ENV,
          reuseExistingServer: true,
          timeout: 60_000,
        },
        ...DOUBLES,
      ],
});

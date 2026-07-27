import { defineConfig } from "@playwright/test";

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
    baseURL: process.env.CONSOLE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A recording per test, so a reviewer can watch what was actually checked
    // rather than read an assertion and take it on trust.
    video: { mode: "on", size: { width: 1000, height: 640 } },
    viewport: { width: 1000, height: 640 },
  },
  // The console, and a stand-in MCP server for it to ask about tools. The
  // graph draws what a server says it offers, so with nothing answering, the
  // tool nodes could only ever be tested as absent.
  webServer: process.env.CONSOLE_URL
    ? [
        {
          command: "node e2e/mcp-double.mjs",
          url: "http://127.0.0.1:8931/mcp",
          ignoreHTTPSErrors: true,
          reuseExistingServer: true,
          timeout: 20_000,
        },
      ]
    : [
        {
          command: "npx vite dev --port 5173",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: "node e2e/mcp-double.mjs",
          url: "http://127.0.0.1:8931/mcp",
          reuseExistingServer: true,
          timeout: 20_000,
        },
      ],
});

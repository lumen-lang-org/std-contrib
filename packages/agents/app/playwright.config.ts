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
  webServer: process.env.CONSOLE_URL
    ? undefined
    : {
        command: "npx vite dev --port 5173",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});

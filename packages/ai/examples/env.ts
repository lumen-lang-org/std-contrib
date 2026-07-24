// Shared environment loading for the examples, backed by the std-contrib
// `dotenv` package. Every example reads its configuration through here so the
// lookup order is the same everywhere:
//
//   1. the real process environment
//   2. a .env in the repository root
//   3. packages/ai/examples/.env
//
// A missing file is not an error — it just falls through to the next source.

import { get as getEnvValue } from "../../dotenv/dotenv.ts";

function readFileOrEmpty(path: string): string {
  if (!fs.existsSync(path)) { return ""; }
  return fs.readFileSync(path);
}

// The value for `key`, or "" when it is set nowhere.
export function envValue(key: string): string {
  let fromEnv = process.env(key) ?? "";
  if (fromEnv != "") { return fromEnv; }

  let root = readFileOrEmpty(".env");
  if (root != "") {
    let v = getEnvValue(root, key, "");
    if (v != "") { return v; }
  }

  let local = readFileOrEmpty("packages/ai/examples/.env");
  if (local != "") {
    let v = getEnvValue(local, key, "");
    if (v != "") { return v; }
  }
  return "";
}

// The value for `key`, or `fallback` when it is set nowhere.
export function envValueOr(key: string, fallback: string): string {
  let v = envValue(key);
  if (v == "") { return fallback; }
  return v;
}

// Read a required value, printing a consistent message and exiting when it is
// missing — the same three-line dance every example used to repeat.
export function requireEnv(key: string): string {
  let v = envValue(key);
  if (v == "") {
    console.error("Set " + key + " in the shell, in .env, or in packages/ai/examples/.env");
    process.exit(1);
  }
  return v;
}

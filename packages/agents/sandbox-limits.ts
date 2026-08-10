// The sandbox's limits, in one place an operator can set.
//
// Every number here was a constant compiled into the binary — the per-owner
// environment cap, the container's memory and CPU, the script wall clock.
// Constants are the right default and the wrong contract: an operator tuning a
// box for its actual load, or clamping down after a red-team, had to rebuild
// the engine to change one number. So the numbers live in a settings row now,
// the modules that enforce them read an override that this applies, and 0
// everywhere means "the compiled default" — an unconfigured deployment behaves
// exactly as it did before this file existed.
//
// One row, JSON, under a single key: these are read together at boot and
// written together from one screen, and a column per number would be a
// migration every time the set grows.
//
// Applied deployment-wide, not per request. A limit is a property of the
// deployment; the enforcement modules hold it in a module value the same way
// scriptWallOverride already did, so applying it is calling the setters once —
// at boot, and again when the screen writes.

import { Db } from "../plume/driver.ts";
import { readSetting, writeSetting } from "./schema.ts";
import { envCapsOverride } from "./environments.ts";
import { envKeyLimitOverride } from "./env-keys.ts";
import { uenvLimitsOverride } from "./user-environments.ts";
import { scriptWallOverride } from "./run-script.ts";

const SETTING_KEY: string = "sandbox_limits";

export type SandboxLimits = {
  // Environments one person may hold. The per-identity cap.
  envsPerOwner: int,
  // Environments the whole deployment may hold, across everyone. 0 = no
  // ceiling. The number the per-owner cap cannot express, and the one that
  // actually bounds shared disk.
  envsGlobal: int,
  // Keys one environment may carry.
  keysPerEnv: int,
  // A script container's memory (MB), CPUs, and process limit — what a
  // runaway or malicious script is bounded by while it runs.
  memoryMb: int,
  cpus: int,
  pidLimit: int,
  // How long a single script may run before it is killed.
  wallSeconds: int,
};

// The compiled defaults, echoed here so the screen can show what a field will
// fall back to when it is left at 0, and so `applySandboxLimits` on an
// unconfigured box is a no-op that sets every override to 0.
export function defaultLimits(): SandboxLimits {
  let d: SandboxLimits = {
    envsPerOwner: 10, envsGlobal: 0, keysPerEnv: 20,
    memoryMb: 1024, cpus: 2, pidLimit: 256, wallSeconds: 60,
  };
  return d;
}

// The stored limits, or all-zero when nothing is stored — zero being "use the
// default", which every reader already honours.
export function sandboxLimits(db: Db): SandboxLimits {
  let raw = readSetting(db, SETTING_KEY);
  if (raw == "") {
    let none: SandboxLimits = {
      envsPerOwner: 0, envsGlobal: 0, keysPerEnv: 0,
      memoryMb: 0, cpus: 0, pidLimit: 0, wallSeconds: 0,
    };
    return none;
  }
  return JSON.parse<SandboxLimits>(raw);
}

// Bounds that keep a typo from becoming an outage. A memory cap below what a
// base image needs to start would make every script fail; a CPU count above
// the host's is meaningless; a wall clock of zero would kill every script at
// once. Each is a floor and a ceiling, not a policy — the policy is the
// operator's, between these.
export function refuseSandboxLimits(l: SandboxLimits): string {
  if (l.envsPerOwner < 0 || l.envsGlobal < 0 || l.keysPerEnv < 0
      || l.memoryMb < 0 || l.cpus < 0 || l.pidLimit < 0 || l.wallSeconds < 0) {
    return "a limit is a count — none of these can be negative";
  }
  if (l.memoryMb != 0 && l.memoryMb < 128) {
    return "a container under 128 MB will not start most images — set 0 for the default, or at least 128";
  }
  if (l.cpus != 0 && l.cpus > 64) { return "that is more CPUs than any host here has — set 0 for the default"; }
  if (l.pidLimit != 0 && l.pidLimit < 16) { return "a pid limit under 16 kills a shell that forks — set 0 for the default"; }
  if (l.wallSeconds != 0 && l.wallSeconds < 5) { return "a wall clock under 5 seconds kills nearly every script — set 0 for the default"; }
  if (l.wallSeconds > 3600) { return "an hour is the most a single script may run — set a smaller number"; }
  if (l.envsGlobal != 0 && l.envsPerOwner != 0 && l.envsGlobal < l.envsPerOwner) {
    return "the global ceiling is below the per-owner cap, so no single person could reach their own limit — raise it or set it to 0";
  }
  return "";
}

// Push the stored limits into the modules that enforce them. Called at boot,
// and again after a write, so the running process reflects the row without a
// restart. Idempotent: the same numbers set twice are the same numbers.
export function applySandboxLimits(db: Db): void {
  let l = sandboxLimits(db);
  uenvLimitsOverride(l.envsPerOwner, l.envsGlobal);
  envKeyLimitOverride(l.keysPerEnv);
  envCapsOverride(l.memoryMb, l.cpus, l.pidLimit);
  scriptWallOverride(l.wallSeconds);
}

// Store and apply in one step: the row is the record, the apply is what makes
// it take effect now. Returns a problem or "".
export function saveSandboxLimits(db: Db, l: SandboxLimits): string {
  let wrong = refuseSandboxLimits(l);
  if (wrong != "") { return wrong; }
  let stored = writeSetting(db, SETTING_KEY, JSON.stringify(l));
  if (stored != "") { return stored; }
  applySandboxLimits(db);
  return "";
}

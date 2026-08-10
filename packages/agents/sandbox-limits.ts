import { Db } from "../plume/driver.ts";
import { readSetting, writeSetting } from "./schema.ts";
import { envCapsOverride } from "./environments.ts";
import { envKeyLimitOverride } from "./env-keys.ts";
import { uenvLimitsOverride } from "./user-environments.ts";
import { scriptWallOverride } from "./run-script.ts";

const SETTING_KEY: string = "sandbox_limits";

export type SandboxLimits = {
  envsPerOwner: int,
  envsGlobal: int,
  keysPerEnv: int,
  memoryMb: int,
  cpus: int,
  pidLimit: int,
  wallSeconds: int,
};

export function defaultLimits(): SandboxLimits {
  let d: SandboxLimits = {
    envsPerOwner: 10, envsGlobal: 0, keysPerEnv: 20,
    memoryMb: 1024, cpus: 2, pidLimit: 256, wallSeconds: 60,
  };
  return d;
}

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

export function refuseSandboxLimits(l: SandboxLimits): string {
  if (l.envsPerOwner < 0 || l.envsGlobal < 0 || l.keysPerEnv < 0
      || l.memoryMb < 0 || l.cpus < 0 || l.pidLimit < 0 || l.wallSeconds < 0) {
    return "a limit is a count — none of these can be negative";
  }
  if (l.memoryMb != 0 && l.memoryMb < 128) {
    return "a container under 128 MB will not start most images — set 0 for the default, or at least 128";
  }
  if (l.cpus != 0 && l.cpus > 64) {
    return "that is more CPUs than any host here has — set 0 for the default";
  }
  if (l.pidLimit != 0 && l.pidLimit < 16) {
    return "a pid limit under 16 kills a shell that forks — set 0 for the default";
  }
  if (l.wallSeconds != 0 && l.wallSeconds < 5) {
    return "a wall clock under 5 seconds kills nearly every script — set 0 for the default";
  }
  if (l.wallSeconds > 3600) {
    return "an hour is the most a single script may run — set a smaller number";
  }
  if (l.envsGlobal != 0 && l.envsPerOwner != 0 && l.envsGlobal < l.envsPerOwner) {
    return "the global ceiling is below the per-owner cap, so no single person could reach their own limit — raise it or set it to 0";
  }
  return "";
}

export function applySandboxLimits(db: Db): void {
  let l = sandboxLimits(db);
  uenvLimitsOverride(l.envsPerOwner, l.envsGlobal);
  envKeyLimitOverride(l.keysPerEnv);
  envCapsOverride(l.memoryMb, l.cpus, l.pidLimit);
  scriptWallOverride(l.wallSeconds);
}

export function saveSandboxLimits(db: Db, l: SandboxLimits): string {
  let wrong = refuseSandboxLimits(l);
  if (wrong != "") {
    return wrong;
  }
  let stored = writeSetting(db, SETTING_KEY, JSON.stringify(l));
  if (stored != "") {
    return stored;
  }
  applySandboxLimits(db);
  return "";
}

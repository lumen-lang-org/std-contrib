import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";

export type OwnerUsage = {
  owner: string,
  bytes: string,
  inputTokens: string,
  outputTokens: string,
};

export function ownerUsage(db: Db, owner: string): OwnerUsage {
  let used: OwnerUsage = {
    owner: owner,
    bytes: artifactBytes(db, owner),
    inputTokens: "0",
    outputTokens: "0",
  };
  let sql = "SELECT SUM(input_tokens), SUM(output_tokens) FROM runs WHERE owner = " + placeholderAt(db, 1);
  if (!db.query(sql, [owner]) || db.rows() == 0) {
    return used;
  }
  let counted: OwnerUsage = {
    owner: owner,
    bytes: used.bytes,
    inputTokens: digitsOrZero(db.value(0, 0)),
    outputTokens: digitsOrZero(db.value(0, 1)),
  };
  return counted;
}

function artifactBytes(db: Db, owner: string): string {
  let sql = "SELECT SUM(artifact_versions.bytes) FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " JOIN threads ON threads.id = artifacts.thread_id"
    + " WHERE threads.owner = " + placeholderAt(db, 1);
  if (!db.query(sql, [owner]) || db.rows() == 0) {
    return "0";
  }
  return digitsOrZero(db.value(0, 0));
}

export function runsSince(db: Db, owner: string, since: string): int {
  let sql = "SELECT COUNT(*) FROM runs WHERE owner = " + placeholderAt(db, 1)
    + " AND created_at >= " + placeholderAt(db, 2);
  if (!db.query(sql, [owner, since]) || db.rows() == 0) {
    return 0;
  }
  return parseInt(digitsOrZero(db.value(0, 0)), 10) ?? 0;
}

const DAY_MILLIS: number = 86400000;

export function utcDayStartText(now: number): string {
  return `${now - (now % DAY_MILLIS)}`;
}

export function secondsToUtcMidnight(now: number): int {
  let start = now - (now % DAY_MILLIS);
  let wait = Math.floor((start + DAY_MILLIS - now) / 1000) + 1;
  return parseInt(`${wait}`, 10) ?? 0;
}

export function nextUtcMidnightIso(now: number): string {
  let days = parseInt(`${(now - (now % DAY_MILLIS) + DAY_MILLIS) / DAY_MILLIS}`, 10) ?? 0;
  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp + (mp < 10 ? 3 : -9);
  if (m <= 2) {
    y = y + 1;
  }
  return `${y}` + "-" + pad2(m) + "-" + pad2(d) + "T00:00:00Z";
}

function pad2(n: int): string {
  if (n < 10) {
    return "0" + `${n}`;
  }
  return `${n}`;
}

function digitsOrZero(said: string): string {
  if (said == "") {
    return "0";
  }
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 48 || c > 57) {
      return "0";
    }
    i = i + 1;
  }
  return said;
}

export function usageJson(used: OwnerUsage): string {
  return "{\"owner\":" + JSON.stringify(used.owner)
    + ",\"bytes\":" + used.bytes
    + ",\"inputTokens\":" + used.inputTokens
    + ",\"outputTokens\":" + used.outputTokens + "}";
}

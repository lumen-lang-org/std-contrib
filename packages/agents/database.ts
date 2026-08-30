import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase } from "../plume/plume.ts";

export function openDatabase(): Db {
  let pgHost = process.env("AGENTS_PG_HOST") ?? "";
  if (pgHost != "") {
    let pg = postgres();
    let named = process.env("AGENTS_PG_DATABASE") ?? "agents";
    let asUser = process.env("AGENTS_PG_USER") ?? "agents";
    let server: DbConfig = {
      host: pgHost,
      database: named,
      user: asUser,
      password: process.env("AGENTS_PG_PASSWORD") ?? "",
    };
    let reached = connectDatabase(pg, server);
    if (!reached.ok) {
      console.error("the database did not open: postgres " + named + " at "
        + pgHost + " as " + asUser + " — " + reached.error);
    }
    return pg;
  }
  let db = sqlite();
  let file = process.env("AGENTS_DB_FILE") ?? "/tmp/agents_api.db";
  let cfg: DbConfig = { filename: file };
  let opened = connectDatabase(db, cfg);
  if (!opened.ok) {
    console.error("the database did not open: sqlite at " + file + " — " + opened.error);
  }
  return db;
}

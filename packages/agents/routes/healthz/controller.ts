import { Db } from "../../../plume/driver.ts";
import { appliedHighWater } from "../../../plume/migrate.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, ok } from "../../../rest/server.ts";
import { boolJson, stamp } from "../../api-core.ts";
import { envDockerUp } from "../../environments.ts";

// The /healthz routes.

// What this build calls itself.
//
// Written by hand because there is no build step to stamp a commit into: the
// Dockerfile runs `lumen compile` and nothing else. It earns its place anyway
// — the answer to "did the restart take" is this number changing, and an
// operator staring at a hot binary that kept the old inode has no other way to
// tell (README, the restart note).
const API_VERSION: string = "0.2.0";

// The health document. A free function, so the suite can ask it the same
// question the probe does — the route is a method on a class and a Lumen
// module cannot export one.
//
// Three facts, and no summary `ok` field. The process refuses to start on a
// schema it could not migrate and refuses to start without a usable master
// key, so a reply at all already means the two fatal things are fine; docker
// being down degrades scripts and nothing else. A boolean over facts of
// different weights would have to lie about one of them, and a prober can
// alert on whichever of these it actually cares about.
export function healthJson(db: Db, now: string): string {
  return "{\"version\":" + JSON.stringify(API_VERSION)
    + ",\"migration\":" + JSON.stringify(appliedHighWater(db))
    + ",\"docker\":" + boolJson(envDockerUp(now)) + "}";
}

@controller("/healthz")
export class HealthApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    return ok(healthJson(this.db, stamp()));
  }
}

// What the /banner routes decide. The class stays in api.ts: `export class`
// makes a Lumen module unimportable.

import { Db } from "../plume/driver.ts";
import { Reply, ok, badRequest } from "../rest/server.ts";
import { readSetting, writeSetting } from "./schema.ts";
import { jsonText } from "./scan.ts";
import { utf8Length } from "./artifacts.ts";

// A sentence, not a page. Bytes rather than characters, because the limit is
// what the column holds and an accented sentence is longer than it looks.
export const BANNER_MAX: int = 500;

export function bannerProblem(text: string): string {
  if (utf8Length(text) > BANNER_MAX) {
    return "a banner is at most 500 bytes — it is a sentence, not a page";
  }
  return "";
}

export function bannerJson(text: string): string {
  return "{\"text\":" + JSON.stringify(text) + "}";
}

export function bannerShow(db: Db): Reply {
  return ok(bannerJson(readSetting(db, "banner")));
}

// "" takes the banner down — same row, empty value — so there is no delete
// route to keep in step.
export function bannerChange(db: Db, body: string): Reply {
  if (body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
  let text = jsonText(body, "text");
  let refused = bannerProblem(text);
  if (refused != "") { return badRequest(refused); }
  let problem = writeSetting(db, "banner", text);
  if (problem != "") { return badRequest(problem); }
  return ok(bannerJson(text));
}

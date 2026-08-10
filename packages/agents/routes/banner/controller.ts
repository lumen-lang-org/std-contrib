import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Reply, Request, badRequest, ok } from "../../../rest/server.ts";
import { readSetting, writeSetting } from "../../schema.ts";
import { utf8Length } from "../../artifacts.ts";

export type BannerAsk = { text: string };

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

export function bannerChange(db: Db, body: string): Reply {
  if (body == "") { return badRequest("a body is required: {\"text\":\"...\"}"); }
  let ask: BannerAsk = JSON.parse<BannerAsk>(body);
  let text = ask.text;
  let refused = bannerProblem(text);
  if (refused != "") { return badRequest(refused); }
  let problem = writeSetting(db, "banner", text);
  if (problem != "") { return badRequest(problem); }
  return ok(bannerJson(text));
}

@controller("/banner")
@bindings
export class BannerApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    return bannerShow(this.db);
  }

  @put("/")
  change(req: Request): Reply {
    return bannerChange(this.db, req.body);
  }
}

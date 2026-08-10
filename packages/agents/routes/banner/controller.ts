import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, BadRequest, Ok } from "../../../rest/server.ts";
import { readSetting, writeSetting } from "../../schema.ts";
import { utf8Length } from "../../artifacts.ts";

export type BannerAsk = { text: string };

export const BANNER_MAX: int = 500;

export function bannerFault(text: string): string {
  if (utf8Length(text) > BANNER_MAX) {
    return "a banner is at most 500 bytes — it is a sentence, not a page";
  }
  return "";
}

export function bannerJson(text: string): string {
  return "{\"text\":" + JSON.stringify(text) + "}";
}

export function bannerShow(db: Db): Reply {
  return Ok(bannerJson(readSetting(db, "banner")));
}

export function bannerChange(db: Db, body: string): Reply {
  if (body == "") {
    return BadRequest("a body is required: {\"text\":\"...\"}");
  }
  let ask: BannerAsk = JSON.parse<BannerAsk>(body);
  let text = ask.text;
  let refused = bannerFault(text);
  if (refused != "") {
    return BadRequest(refused);
  }
  let fault = writeSetting(db, "banner", text);
  if (fault != "") {
    return BadRequest(fault);
  }
  return Ok(bannerJson(text));
}

@controller("/banner")
@bindings
export class BannerApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  show(req: Request): Reply {
    return bannerShow(this.db);
  }

  @Put("/")
  change(req: Request): Reply {
    return bannerChange(this.db, req.body);
  }
}

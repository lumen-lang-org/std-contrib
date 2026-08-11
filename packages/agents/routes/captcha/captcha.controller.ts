import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, answered, Ok, OkJson } from "../../../rest/server.ts";
import { CaptchaService } from "./captcha.service.ts";
import { CaptchaAsk } from "./dtos/captcha-ask.dto.ts";

@controller("/captcha")
@bindings
export class CaptchaApi {
  captcha: CaptchaService;

  constructor(database: Db, master: string) {
    this.captcha = new CaptchaService(database, master);
  }

  @Get("/")
  show(): Reply {
    return OkJson(this.captcha.view());
  }

  @Get("/resolved")
  resolved(): Reply {
    return Ok(this.captcha.resolvedDocument());
  }

  @Put("/")
  change(@Valid @RequestBody ask: CaptchaAsk): Reply {
    return answered(this.captcha.change(ask));
  }

  @Put("/secret")
  setSecret(@RequestBody body: string): Reply {
    return answered(this.captcha.setSecret(body));
  }
}

import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, answered, OkJson } from "../../../../rest/server.ts";
import { BannerService } from "./banner.service.ts";

@controller("/banner")
@bindings
export class BannerApi {
  banner: BannerService;

  constructor(database: Db) {
    this.banner = new BannerService(database);
  }

  @Get("/")
  show(): Reply {
    return OkJson(this.banner.view());
  }

  @Put("/")
  change(@RequestBody body: string): Reply {
    return answered(this.banner.change(body));
  }
}

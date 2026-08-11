import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, answered, NoContent, NotFound, OkJson } from "../../../rest/server.ts";
import { KeyBody } from "./dtos/key-body.dto.ts";
import { ProviderService } from "./provider.service.ts";

@controller("/providers")
@bindings
export class ProviderApi {
  providers: ProviderService;

  constructor(database: Db, master: string) {
    this.providers = new ProviderService(database, master);
  }

  @Get("/")
  list(): Reply {
    return OkJson(this.providers.listing());
  }

  @Get("/:provider")
  status(@PathVariable("provider") provider: string): Reply {
    return OkJson(this.providers.status(provider));
  }

  @Put("/:provider/key")
  setKey(@PathVariable("provider") provider: string, @Valid @RequestBody body: KeyBody): Reply {
    return answered(this.providers.setKey(provider, body));
  }

  @Delete("/:provider/key")
  clearKey(@PathVariable("provider") provider: string): Reply {
    if (!this.providers.clearKey(provider)) {
      return NotFound("no key for " + provider);
    }
    return NoContent();
  }
}

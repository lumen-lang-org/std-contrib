import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Bound } from "../../../../rest/plan.ts";
import { Guarded, Reply, Request, answered, NotFound, Ok, Respond } from "../../../../rest/server.ts";
import { pluginInstalled } from "./card-plugin.guard.ts";
import { CardPluginService } from "./card-plugin.service.ts";

@controller("/card-plugins")
@bindings
export class CardPluginApi {
  plugins: CardPluginService;

  constructor(database: Db) {
    this.plugins = new CardPluginService(database);
  }

  thePlugin(request: Request): Guarded {
    return pluginInstalled(this.plugins, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.plugins.listing());
  }

  @Post("/")
  install(@RequestBody body: string): Reply {
    return answered(this.plugins.install(body));
  }

  @Put("/:id")
  @Guard(thePlugin)
  change(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    return answered(this.plugins.change(id, body));
  }

  @Delete("/:id")
  @Guard(thePlugin)
  remove(@PathVariable("id") id: string): Reply {
    return answered(this.plugins.forget(id));
  }

  @Post("/from-source")
  fromSource(@RequestBody body: string): Reply {
    return answered(this.plugins.fromSource(body));
  }

  @Get("/:id/renderer")
  @Guard(thePlugin)
  renderer(@PathVariable("id") id: string): Reply {
    let source = this.plugins.renderer(id);
    if (source == "") {
      return NotFound("plugin " + id + " ships no renderer");
    }
    let answer: Reply = {
      status: 200, body: source,
      headers: new Map<string, string>([["Content-Type", "text/javascript; charset=utf-8"]]),
    };
    return answer;
  }

  @Get("/:id/cases")
  cases(@PathVariable("id") id: string): Reply {
    return Ok(this.plugins.cases(id));
  }
}

import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok, OkJson } from "../../../rest/server.ts";
import { PluginAsk } from "./dtos/plugin-ask.dto.ts";
import { pluginExists } from "./plugin.guard.ts";
import { PluginService } from "./plugin.service.ts";

@controller("/plugins")
@bindings
export class PluginApi {
  plugins: PluginService;

  constructor(database: Db) {
    this.plugins = new PluginService(database);
  }

  thePlugin(request: Request): Guarded {
    return pluginExists(this.plugins, request);
  }

  @Get("/")
  list(): Reply {
    return Ok(this.plugins.listing());
  }

  @Get("/:id/items")
  @Guard(thePlugin)
  items(@PathVariable("id") id: string): Reply {
    return OkJson(this.plugins.items(id));
  }

  @Post("/inspect")
  inspect(@Valid @RequestBody ask: PluginAsk): Reply {
    return answered(this.plugins.inspect(ask.sourceUrl));
  }

  @Post("/install")
  add(@Valid @RequestBody ask: PluginAsk): Reply {
    let made = this.plugins.install(ask.sourceUrl);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Delete("/:id")
  @Guard(thePlugin)
  remove(@PathVariable("id") id: string): Reply {
    this.plugins.forget(id);
    return NoContent();
  }
}

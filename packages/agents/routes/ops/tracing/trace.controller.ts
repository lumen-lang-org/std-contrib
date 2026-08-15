import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, answered, NotFound, Ok } from "../../../../rest/server.ts";
import { TraceService } from "./trace.service.ts";

@controller("/tracing")
@bindings
export class TraceApi {
  trace: TraceService;

  constructor(database: Db, master: string) {
    this.trace = new TraceService(database, master);
  }

  @Get("/")
  status(): Reply {
    return Ok(this.trace.status());
  }

  @Put("/")
  configure(@RequestBody body: string): Reply {
    return answered(this.trace.configure(body));
  }

  @Put("/key")
  setKey(@RequestBody body: string): Reply {
    return answered(this.trace.setKey(body));
  }

  @Delete("/key")
  clearKey(): Reply {
    if (!this.trace.clearKey()) {
      return NotFound("a tracing key");
    }
    return Ok(this.trace.status());
  }
}

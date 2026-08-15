import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Guarded, Reply, Request } from "../../../../rest/server.ts";
import { keyScopedFor } from "./v1.guard.ts";
import { V1Service } from "./v1.service.ts";
import { ForwardCall, forwardCallOf } from "./v1.utils.ts";

@controller("/v1")
@bindings
export class V1Api {
  v1: V1Service;

  constructor(database: Db) {
    this.v1 = new V1Service(database);
  }

  searchScoped(request: Request): Guarded {
    return keyScopedFor(this.v1, request, "search");
  }

  retrieveScoped(request: Request): Guarded {
    return keyScopedFor(this.v1, request, "retrieve");
  }

  suggestScoped(request: Request): Guarded {
    return keyScopedFor(this.v1, request, "suggest");
  }

  @Get("/search")
  @Guard(searchScoped)
  search(@From(forwardCallOf) call: ForwardCall): Reply {
    return this.v1.forward("search", call);
  }

  @Get("/retrieve")
  @Guard(retrieveScoped)
  retrieve(@From(forwardCallOf) call: ForwardCall): Reply {
    return this.v1.forward("retrieve", call);
  }

  @Get("/suggest")
  @Guard(suggestScoped)
  suggest(@From(forwardCallOf) call: ForwardCall): Reply {
    return this.v1.forward("suggest", call);
  }
}

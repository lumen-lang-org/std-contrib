import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Ok, Reply } from "../../../rest/server.ts";
import { scopesNeedPostgres } from "./scope.guard.ts";
import { ScopeService } from "./scope.service.ts";

@controller("/scopes")
@bindings
export class ScopeApi {
  scopes: ScopeService;

  constructor(database: Db) {
    this.scopes = new ScopeService(database);
  }

  needsPg(): Guarded {
    return scopesNeedPostgres(this.scopes);
  }

  @Get("/")
  @Guard(needsPg)
  tree(@RequestParam("prefix", "") prefix: string): Reply {
    return Ok(this.scopes.tree(prefix));
  }
}

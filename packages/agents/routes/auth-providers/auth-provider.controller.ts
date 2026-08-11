import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, OkJson } from "../../../rest/server.ts";
import { authProviderExists } from "./auth-provider.guard.ts";
import { AuthProviderService } from "./auth-provider.service.ts";
import { AuthProviderAsk } from "./dtos/auth-provider-ask.dto.ts";
import { AuthProviderSecretAsk } from "./dtos/auth-provider-secret-ask.dto.ts";

@controller("/auth-providers")
@bindings
export class AuthProviderApi {
  authProviders: AuthProviderService;

  constructor(database: Db, master: string) {
    this.authProviders = new AuthProviderService(database, master);
  }

  theAuthProvider(request: Request): Guarded {
    return authProviderExists(this.authProviders, request);
  }

  @Get("/")
  list(): Reply {
    return OkJson(this.authProviders.listing());
  }

  @Get("/resolved")
  resolved(): Reply {
    return OkJson(this.authProviders.resolved());
  }

  @Post("/")
  create(@Valid @RequestBody ask: AuthProviderAsk, @RequestBody document: string): Reply {
    let made = this.authProviders.create(ask, document);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theAuthProvider)
  update(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderAsk,
         @RequestBody document: string): Reply {
    return answered(this.authProviders.update(id, ask, document));
  }

  @Put("/:id/secret")
  @Guard(theAuthProvider)
  setSecret(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderSecretAsk): Reply {
    return answered(this.authProviders.setSecret(id, ask.clientSecret));
  }

  @Delete("/:id")
  @Guard(theAuthProvider)
  remove(@PathVariable("id") id: string): Reply {
    let gone = this.authProviders.forget(id);
    if (gone.fault != "") {
      return BadRequest(gone.fault);
    }
    return NoContent();
  }
}

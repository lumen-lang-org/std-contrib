import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, BadRequest, NoContent, NotFound, OkJson, Refused } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, masterKey, masterKeyFault, providersWithCredentials, storeCredential } from "../../credentials.ts";
import { KeyBody, ProviderStatus } from "./types.ts";

@controller("/providers")
@bindings
export class ProviderApi {
  db: Db;
  master: string;

  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  list(): Reply {
    let names: string[] = providersWithCredentials(this.db);
    return OkJson(names);
  }

  @Get("/:provider")
  status(@PathVariable("provider") provider: string): Reply {
    let usable = credentialFor(this.db, provider, this.master) != "";
    let v: ProviderStatus = { provider: provider, configured: usable };
    return OkJson(v);
  }

  @Put("/:provider/key")
  setKey(@PathVariable("provider") provider: string, @Valid @RequestBody body: KeyBody): Reply {
    let fault = masterKeyFault(this.master);
    if (fault != "") {
      return BadRequest(fault);
    }
    let stored = storeCredential(this.db, {
      provider: provider,
      apiKey: body.apiKey,
      masterKey: this.master,
      now: stamp(),
    });
    if (stored != "") {
      return BadRequest(stored);
    }
    let v: ProviderStatus = { provider: provider, configured: true };
    return OkJson(v);
  }

  @Delete("/:provider/key")
  clearKey(@PathVariable("provider") provider: string): Reply {
    if (!forgetCredential(this.db, provider)) {
      return NotFound("no key for " + provider);
    }
    return NoContent();
  }
}

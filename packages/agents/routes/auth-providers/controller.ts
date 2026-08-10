import { Db } from "../../../plume/driver.ts";
import { DbOrder, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, BadRequest, Created, NoContent, NotFound, Ok, OkJson } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, hasCredential, storeCredential } from "../../credentials.ts";
import { createFault } from "../../payload.ts";
import { AuthProviderRow, authProvidersMapping } from "../../schema.ts";
import { AuthProviderAsk, AuthProviderResolvedView, AuthProviderSecretAsk, AuthProviderSecretStored, AuthProviderView } from "./types.ts";

export function authProviderFault(ask: AuthProviderAsk): string {
  let kind = ask.kind == "" ? "oidc" : ask.kind;
  if (kind == "oidc" && !ask.issuer.startsWith("https://")) {
    return "the issuer is an https address whose /.well-known/openid-configuration describes the provider";
  }
  return "";
}

@controller("/auth-providers")
@bindings
export class AuthProviderApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) {
    this.db = db;
    this.master = master;
  }

  @Get("/")
  list(): Reply {
    let keys: DbOrder[] = [{ column: "label" }];
    let rows = JSON.parse<AuthProviderRow[]>(listOrdered(this.db, authProvidersMapping(), {
      order: keys,
    }));
    let views: AuthProviderView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: AuthProviderView = {
        id: rows[i].id,
        label: rows[i].label,
        kind: rows[i].kind == "" ? "oidc" : rows[i].kind,
        issuer: rows[i].issuer,
        clientId: rows[i].clientId,
        scopes: rows[i].scopes,
        enabled: rows[i].enabled,
        configured: hasCredential(this.db, "oauth:" + rows[i].id),
      };
      views.push(one);
      i = i + 1;
    }
    return OkJson(views);
  }

  @Get("/resolved")
  resolved(): Reply {
    let rows = JSON.parse<AuthProviderRow[]>(listWhere(this.db, authProvidersMapping(),
      "enabled = " + placeholderAt(this.db, 1), ["1"]));
    let views: AuthProviderResolvedView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let secret = credentialFor(this.db, "oauth:" + rows[i].id, this.master);
      if (secret != "") {
        let one: AuthProviderResolvedView = {
          id: rows[i].id,
          label: rows[i].label,
          kind: rows[i].kind == "" ? "oidc" : rows[i].kind,
          issuer: rows[i].issuer,
          clientId: rows[i].clientId,
          clientSecret: secret,
          scopes: rows[i].scopes,
        };
        views.push(one);
      }
      i = i + 1;
    }
    return OkJson(views);
  }

  @Post("/")
  create(@Valid @RequestBody ask: AuthProviderAsk, @RequestBody document: string): Reply {
    let fault = createFault(this.db, authProvidersMapping(), document);
    if (fault != "") {
      return BadRequest(fault);
    }
    let bad = authProviderFault(ask);
    if (bad != "") {
      return BadRequest(bad);
    }
    let written = persist(this.db, authProvidersMapping(), document);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, authProvidersMapping(), ask.id));
  }

  @Put("/:id")
  update(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderAsk,
         @RequestBody document: string): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return NotFound("auth provider " + id);
    }
    if (ask.id != id) {
      return BadRequest("the id in the body must match the path");
    }
    let bad = authProviderFault(ask);
    if (bad != "") {
      return BadRequest(bad);
    }
    let written = persist(this.db, authProvidersMapping(), document);
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, authProvidersMapping(), id));
  }

  @Put("/:id/secret")
  setSecret(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderSecretAsk): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return NotFound("auth provider " + id);
    }
    let stored = storeCredential(this.db, { provider: "oauth:" + id,
      apiKey: ask.clientSecret, masterKey: this.master, now: stamp() });
    if (stored != "") {
      return BadRequest(stored);
    }
    let v: AuthProviderSecretStored = { configured: true };
    return OkJson(v);
  }

  @Delete("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return NotFound("auth provider " + id);
    }
    forgetCredential(this.db, "oauth:" + id);
    deleteById(this.db, authProvidersMapping(), id);
    return NoContent();
  }
}

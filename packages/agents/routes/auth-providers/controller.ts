import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, badRequest, created, noContent, notFound, ok, okJson } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, hasCredential, storeCredential } from "../../credentials.ts";
import { createProblem } from "../../payload.ts";
import { AuthProviderRow, authProvidersMapping } from "../../schema.ts";
import { AuthProviderAsk, AuthProviderResolvedView, AuthProviderSecretAsk, AuthProviderSecretStored, AuthProviderView } from "./types.ts";

export function authProviderProblem(ask: AuthProviderAsk): string {
  let kind = ask.kind == "" ? "oidc" : ask.kind;
  if (kind == "oidc" && !ask.issuer.startsWith("https://")) {
    return "the issuer is an https address whose /.well-known/openid-configuration describes the provider";
  }
  return "";
}

@controller("/auth-providers")
export class AuthProviderApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(): Reply {
    let keys: DbOrder[] = [asc("label")];
    let rows = JSON.parse<AuthProviderRow[]>(listOrdered(this.db, authProvidersMapping(), "", [], keys));
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
    return okJson(views);
  }

  @get("/resolved")
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
    return okJson(views);
  }

  @post("/")
  create(@Valid @RequestBody ask: AuthProviderAsk, @RequestBody document: string): Reply {
    let problem = createProblem(this.db, authProvidersMapping(), document);
    if (problem != "") { return badRequest(problem); }
    let bad = authProviderProblem(ask);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), document);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, authProvidersMapping(), ask.id));
  }

  @put("/:id")
  update(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderAsk,
         @RequestBody document: string): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return notFound("auth provider " + id);
    }
    if (ask.id != id) { return badRequest("the id in the body must match the path"); }
    let bad = authProviderProblem(ask);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), document);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, authProvidersMapping(), id));
  }

  @put("/:id/secret")
  setSecret(@PathVariable("id") id: string, @Valid @RequestBody ask: AuthProviderSecretAsk): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return notFound("auth provider " + id);
    }
    let stored = storeCredential(this.db, { provider: "oauth:" + id,
      apiKey: ask.clientSecret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    let v: AuthProviderSecretStored = { configured: true };
    return okJson(v);
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, authProvidersMapping(), id)) {
      return notFound("auth provider " + id);
    }
    forgetCredential(this.db, "oauth:" + id);
    deleteById(this.db, authProvidersMapping(), id);
    return noContent();
  }
}

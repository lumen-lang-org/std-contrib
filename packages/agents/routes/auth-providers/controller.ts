import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, deleteById, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson, param, problem } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { credentialFor, forgetCredential, hasCredential, masterKey, storeCredential } from "../../credentials.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { jsonText } from "../../scan.ts";
import { AuthProviderRow, authProvidersMapping } from "../../schema.ts";
import { AuthProviderResolvedView, AuthProviderSecretStored, AuthProviderView } from "./types.ts";

export function authProviderProblem(row: AuthProviderRow): string {
  if (row.id.trim() == "") { return "a provider needs an id — it is what the callback URL carries"; }
  if (row.label.trim() == "") { return "a provider needs a label — it is what the sign-in button says"; }
  let kind = row.kind == "" ? "oidc" : row.kind;
  if (kind != "oidc" && kind != "github") { return "kind is 'oidc' or 'github'"; }
  if (kind == "oidc" && !row.issuer.startsWith("https://")) {
    return "the issuer is an https address whose /.well-known/openid-configuration describes the provider";
  }
  if (row.clientId.trim() == "") { return "a client id is required"; }
  return "";
}

@controller("/auth-providers")
export class AuthProviderApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
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
  resolved(req: Request): Reply {
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
  create(req: Request): Reply {
    let problem = createProblem(this.db, authProvidersMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let row: AuthProviderRow = JSON.parse<AuthProviderRow>(req.body);
    let bad = authProviderProblem(row);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, authProvidersMapping(), jsonId(req.body)));
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    let row: AuthProviderRow = JSON.parse<AuthProviderRow>(req.body);
    if (row.id != param(req, "id")) { return badRequest("the id in the body must match the path"); }
    let bad = authProviderProblem(row);
    if (bad != "") { return badRequest(bad); }
    let written = persist(this.db, authProvidersMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, authProvidersMapping(), param(req, "id")));
  }

  @put("/:id/secret")
  setSecret(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    let secret = jsonText(req.body, "clientSecret");
    if (secret == "") { return badRequest("a client secret is required"); }
    let stored = storeCredential(this.db, { provider: "oauth:" + param(req, "id"),
      apiKey: secret, masterKey: this.master, now: stamp() });
    if (stored != "") { return badRequest(stored); }
    let v: AuthProviderSecretStored = { configured: true };
    return okJson(v);
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, authProvidersMapping(), param(req, "id"))) {
      return notFound("auth provider " + param(req, "id"));
    }
    forgetCredential(this.db, "oauth:" + param(req, "id"));
    deleteById(this.db, authProvidersMapping(), param(req, "id"));
    return noContent();
  }
}

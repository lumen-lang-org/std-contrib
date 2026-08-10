// The /models routes.

import { Db } from "../plume/driver.ts";
import { DbOrder, asc, countWhere, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../plume/plume.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, param, problem } from "../rest/server.ts";
import { DestinationMove, credentialFor, destinationOf, destinationProblem, hasCredential } from "./credentials.ts";
import { createProblem, jsonId } from "./payload.ts";
import { complete, embedText, embeddingEndpoint, endpointFor, replyText } from "./provider.ts";
import { ModelChoiceRow, ModelConfigRow, ModelRow, enabledChoices, modelConfigsMapping, modelsMapping } from "./schema.ts";

// The model menu, as the composer draws it.
//
// `configId` and `routerId` are deliberately not on the wire. They are the
// operator's plumbing, and a client that can see them is a client that will
// eventually send one back as a `modelChoiceId` — which names no choice row,
// so it would be refused at the door and read as the menu being broken. What a
// caller may name is a choice id, and everything needed to draw one is here.
//
// `enabled` and `rank` are absent for the same kind of reason: every row in
// this answer is enabled and the array is already in rank order, so both
// fields would carry one value forever and invite a client to filter or sort
// on them — work that can only produce the same list again.
export function choicesJson(rows: ModelChoiceRow[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"id\":" + JSON.stringify(rows[i].id)
      + ",\"label\":" + JSON.stringify(rows[i].label)
      + ",\"description\":" + JSON.stringify(rows[i].description)
      // "config" or "router" — the console shows an automatic choice
      // differently, and it is the row that says which it is rather than
      // whichever of two ids happens to be filled in.
      + ",\"kind\":" + JSON.stringify(rows[i].kind)
      // "" or "premium". Rendered as a lock and enforced nowhere near here;
      // see the messages POST, which is where a choice is applied.
      + ",\"tier\":" + JSON.stringify(rows[i].tier) + "}";
    i = i + 1;
  }
  return out + "]";
}

// What the rest of the package can actually reach. A model row naming a
// provider with no endpoint is accepted today and fails at the first run with
// a blank URL; a model row naming no width is accepted and fails when the
// corpus table is made, long after anyone connects the two.
export function modelProblem(m: ModelRow): string {
  if (m.label.trim() == "") { return "a model needs a label"; }
  if (m.apiName.trim() == "") { return "a model needs the provider's own name for it"; }
  if (m.kind != "chat" && m.kind != "embedding") {
    return "a model is chat or embedding, not \"" + m.kind + "\"";
  }
  // Vertex has no well-known endpoint: the address carries the project and
  // region, so the row must say it. Named before the generic refusals below,
  // which would otherwise reject every vertex row however complete.
  if (m.provider == "vertex" && m.baseUrl.trim() == "") {
    return "a vertex model needs its base URL — https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/endpoints/openapi";
  }
  if (m.kind == "chat" && m.baseUrl.trim() == "" && chatEndpoint(m.provider) == "") {
    return "no chat endpoint for provider \"" + m.provider + "\"";
  }
  if (m.kind == "embedding" && m.baseUrl.trim() == "" && embeddingEndpoint(m.provider) == "") {
    return "no embedding endpoint for provider \"" + m.provider + "\"";
  }
  if (m.kind == "embedding" && m.dimensions <= 0) {
    return "an embedding model must say how wide its vectors are";
  }
  // The one field here that decides where a key is sent, and the one this
  // never read. A base URL that is not an address cannot be compared with the
  // address the key was stored for, so it is refused where it is written
  // rather than where it is used.
  if (m.baseUrl.trim() != "" && destinationOf(m.baseUrl) == "") {
    return "a base URL is an http or https address, like \"https://gateway.internal/v1\" — not \"" + m.baseUrl + "\"";
  }
  return "";
}

// Where a model row's calls actually land: its base URL when it has one, and
// the provider's own endpoint when it does not.
function modelDestination(m: ModelRow): string {
  if (m.kind == "embedding") { return endpointFor(m, "embeddings"); }
  return endpointFor(m, "chat/completions");
}

// Whether this model row may be written, given what is stored for its
// provider.
//
// A model row names a key — through its provider — and a destination, through
// its base URL, and only the first of those is write-only. `modelProblem`
// checks the label, the api name, the kind and the width and has never looked
// at `baseUrl`, so `PUT /models/:id {"baseUrl":"http://…"}` followed by `POST
// /models/:id/test` sends `authorization: Bearer <the stored key>` wherever
// you like. `/test` re-materialises the row with `enabled: true`, so a
// disabled row is no protection either.
//
// A row that does not exist yet is treated as one pointing at the provider's
// own endpoint: a fresh row naming someone else's host leaks precisely as much
// as an edited one, and `POST /models` is the shorter way to write it.
export function modelDestinationProblem(db: Db, row: ModelRow): string {
  let held = findById(db, modelsMapping(), row.id);
  let authorised: ModelRow = {
    id: row.id, label: row.label, apiName: row.apiName, provider: row.provider,
    kind: row.kind, dimensions: row.dimensions, baseUrl: "", enabled: row.enabled, contextTokens: 0 };
  if (held != "") { authorised = JSON.parse<ModelRow>(held); }
  let move: DestinationMove = {
    subject: "model " + row.id,
    secretName: "the " + row.provider + " key",
    clearWith: "DELETE /providers/" + row.provider + "/key",
    was: modelDestination(authorised),
    now: modelDestination(row),
    secretStored: hasCredential(db, row.provider),
  };
  return destinationProblem(move);
}

@controller("/models")
export class ModelApi {
  db: Db;
  // Testing a model calls it, which needs the key out of the encrypted store.
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, modelsMapping(), "", [], keys));
  }

  // The menu a person picks from, in the order it is shown.
  //
  // Not scoped to a caller and not filtered by one: `model_choices` is the
  // operator's product surface, exactly as `models` and `script_images` are,
  // and every caller sees the same list — including the premium rows they may
  // not be able to pick, because a menu that hides what upgrading would buy
  // cannot sell it (MODEL-CHOICE.md, "the menu, which only renders the lock").
  //
  // A curated table rather than "every enabled chat config", and the live
  // deployment is the argument: it holds `c-double`, the e2e's fake provider,
  // and three `e2e-link-*` agents. An uncurated menu offers those to real
  // people.
  //
  // A literal under a prefix that also has parameter routes, so it is declared
  // above them — the router matches in order, and a `:id` written first would
  // shadow this. There is no GET /:id here today; this is the line one would
  // have to go below.
  @get("/choices")
  choices(req: Request): Reply {
    return ok(choicesJson(enabledChoices(this.db)));
  }

  @post("/")
  create(req: Request): Reply {
    let problem = createProblem(this.db, modelsMapping(), req.body);
    if (problem != "") { return badRequest(problem); }
    let m: ModelRow = JSON.parse<ModelRow>(req.body);
    let wrong = modelProblem(m);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, m);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, modelsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelsMapping(), jsonId(req.body)));
  }

  // Enabled is the kill switch: flipping it refuses the next call to every
  // agent on this model, which is the point of it being a column.
  // Call the model once and say what happened. A row can name a provider, a
  // base URL and a key and still be wrong in a way only the provider knows —
  // a retired model id, a gateway that speaks a different dialect, a key
  // without access. Finding that out at the first conversation is finding it
  // out in front of a user.
  @post("/:id/test")
  test(req: Request): Reply {
    let document = findById(this.db, modelsMapping(), param(req, "id"));
    if (document == "") { return notFound("model " + param(req, "id")); }
    let stored: ModelRow = JSON.parse<ModelRow>(document);
    let key = credentialFor(this.db, stored.provider, this.master);
    if (key == "") { return badRequest("no credential stored for " + stored.provider); }

    // Tested as if enabled. A test is what you run to decide whether to enable
    // a row, so refusing to test a disabled one refuses the only question the
    // button is asked.
    let model: ModelRow = {
      id: stored.id, label: stored.label, apiName: stored.apiName,
      provider: stored.provider, kind: stored.kind, dimensions: stored.dimensions,
      baseUrl: stored.baseUrl, enabled: true, contextTokens: 0 };

    if (model.kind == "embedding") {
      let vector = embedText(model, "a probe from the console", key);
      if (!vector.ok) { return ok("{\"ok\":false,\"error\":" + JSON.stringify(vector.error) + "}"); }
      // The width it returns is the width the corpus was built at. A model
      // that answers a different number is not the model this row describes.
      let agrees = vector.dimensions == model.dimensions;
      return ok("{\"ok\":" + `${agrees}`
        + ",\"dimensions\":" + `${vector.dimensions}`
        + ",\"declared\":" + `${model.dimensions}`
        + ",\"error\":" + JSON.stringify(agrees ? "" : "the model returned a different width than this row declares") + "}");
    }

    // Never persisted and never offered: this row exists for the length of one
    // "does this model answer" call, so it is unlabelled and not selectable.
    let config: ModelConfigRow = { id: "probe", modelId: model.id, temperature: 0, maxTokens: 16, topP: 1, extra: "" , thinking: "", label: "", selectable: false, rank: 0 };
    let said = complete(model, config, "Reply with the single word: ok", "ping", key);
    if (!said.ok) { return ok("{\"ok\":false,\"error\":" + JSON.stringify(said.error) + "}"); }
    // The provider's whole envelope is not an answer. replyText pulls the
    // assistant's own words out of it, which is what a person is looking at.
    let answer = replyText(model.provider, said.text);
    return ok("{\"ok\":true,\"reply\":" + JSON.stringify(answer.slice(0, 120))
      + ",\"inputTokens\":" + `${said.inputTokens}`
      + ",\"outputTokens\":" + `${said.outputTokens}` + "}");
  }

  @put("/:id")
  update(req: Request): Reply {
    if (!existsById(this.db, modelsMapping(), param(req, "id"))) {
      return notFound("model " + param(req, "id"));
    }
    if (req.body == "") { return badRequest("a body is required"); }
    let row: ModelRow = JSON.parse<ModelRow>(req.body);
    if (row.id != param(req, "id")) {
      return badRequest("the id in the body must match the path");
    }
    let wrong = modelProblem(row);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, row);
    if (moved != "") { return badRequest(moved); }

    // At most one embedding model is enabled at a time. Enforced here rather
    // than asked of a caller: two enabled embedders is not a preference, it is
    // a corpus split in half — a document embedded by one is invisible to
    // every agent retrieving through the other, and nothing reports it.
    if (row.enabled && row.kind == "embedding") {
      executeWith(this.db, "UPDATE models SET enabled = " + this.db.placeholder
        + " WHERE kind = " + placeholderAt(this.db, 2)
        + " AND id <> " + placeholderAt(this.db, 3), ["0", "embedding", param(req, "id")]);
    }
    let written = persist(this.db, modelsMapping(), req.body);
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, modelsMapping(), param(req, "id")));
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!existsById(this.db, modelsMapping(), param(req, "id"))) {
      return notFound("model " + param(req, "id"));
    }
    if (countWhere(this.db, modelConfigsMapping(this.db), "model_id = " + this.db.placeholder, [param(req, "id")]) > 0) {
      return badRequest("model " + param(req, "id") + " is used by a model config; delete or repoint those first");
    }
    deleteById(this.db, modelsMapping(), param(req, "id"));
    return noContent();
  }
}

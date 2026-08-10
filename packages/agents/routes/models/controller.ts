import { Db } from "../../../plume/driver.ts";
import { DbOrder, asc, countWhere, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson, param } from "../../../rest/server.ts";
import { DestinationMove, credentialFor, destinationOf, destinationProblem, hasCredential } from "../../credentials.ts";
import { createProblem, jsonId } from "../../payload.ts";
import { complete, embedText, embeddingEndpoint, endpointFor, replyText } from "../../provider.ts";
import { ModelChoiceRow, ModelConfigRow, ModelRow, enabledChoices, modelConfigsMapping, modelsMapping } from "../../schema.ts";
import { ChatProbe, EmbeddingProbe, ModelTestFailed } from "./types.ts";

export function choicesJson(rows: ModelChoiceRow[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"id\":" + JSON.stringify(rows[i].id)
      + ",\"label\":" + JSON.stringify(rows[i].label)
      + ",\"description\":" + JSON.stringify(rows[i].description)
      + ",\"kind\":" + JSON.stringify(rows[i].kind)
      + ",\"tier\":" + JSON.stringify(rows[i].tier) + "}";
    i = i + 1;
  }
  return out + "]";
}

export function modelProblem(m: ModelRow): string {
  if (m.label.trim() == "") { return "a model needs a label"; }
  if (m.apiName.trim() == "") { return "a model needs the provider's own name for it"; }
  if (m.kind != "chat" && m.kind != "embedding") {
    return "a model is chat or embedding, not \"" + m.kind + "\"";
  }
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
  if (m.baseUrl.trim() != "" && destinationOf(m.baseUrl) == "") {
    return "a base URL is an http or https address, like \"https://gateway.internal/v1\" — not \"" + m.baseUrl + "\"";
  }
  return "";
}

function modelDestination(m: ModelRow): string {
  if (m.kind == "embedding") { return endpointFor(m, "embeddings"); }
  return endpointFor(m, "chat/completions");
}

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
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("label")];
    return ok(listOrdered(this.db, modelsMapping(), "", [], keys));
  }

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

  @post("/:id/test")
  test(req: Request): Reply {
    let document = findById(this.db, modelsMapping(), param(req, "id"));
    if (document == "") { return notFound("model " + param(req, "id")); }
    let stored: ModelRow = JSON.parse<ModelRow>(document);
    let key = credentialFor(this.db, stored.provider, this.master);
    if (key == "") { return badRequest("no credential stored for " + stored.provider); }

    let model: ModelRow = {
      id: stored.id, label: stored.label, apiName: stored.apiName,
      provider: stored.provider, kind: stored.kind, dimensions: stored.dimensions,
      baseUrl: stored.baseUrl, enabled: true, contextTokens: 0 };

    if (model.kind == "embedding") {
      let vector = embedText(model, "a probe from the console", key);
      if (!vector.ok) {
        let failed: ModelTestFailed = { ok: false, error: vector.error };
        return okJson(failed);
      }
      let agrees = vector.dimensions == model.dimensions;
      let probe: EmbeddingProbe = {
        ok: agrees,
        dimensions: vector.dimensions,
        declared: model.dimensions,
        error: agrees ? "" : "the model returned a different width than this row declares",
      };
      return okJson(probe);
    }

    let config: ModelConfigRow = { id: "probe", modelId: model.id, temperature: 0, maxTokens: 16, topP: 1, extra: "" , thinking: "", label: "", selectable: false, rank: 0 };
    let said = complete(model, config, "Reply with the single word: ok", "ping", key);
    if (!said.ok) {
      let failed: ModelTestFailed = { ok: false, error: said.error };
      return okJson(failed);
    }
    let answer = replyText(model.provider, said.text);
    let probe: ChatProbe = {
      ok: true,
      reply: answer.slice(0, 120),
      inputTokens: said.inputTokens,
      outputTokens: said.outputTokens,
    };
    return okJson(probe);
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

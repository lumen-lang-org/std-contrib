import { Db } from "../../../plume/driver.ts";
import { DbOrder, countWhere, deleteById, executeWith, existsById, findById, listOrdered, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, badRequest, created, noContent, notFound, ok, okJson } from "../../../rest/server.ts";
import { DestinationMove, credentialFor, destinationOf, destinationProblem, hasCredential } from "../../credentials.ts";
import { createProblem } from "../../payload.ts";
import { complete, embedText, embeddingEndpoint, endpointFor, replyText } from "../../provider.ts";
import { ModelChoiceRow, ModelConfigRow, ModelRow, enabledChoices, modelConfigsMapping, modelsMapping } from "../../schema.ts";
import { ChatProbe, EmbeddingProbe, ModelAsk, ModelTestFailed } from "./types.ts";

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

export function modelRowOf(ask: ModelAsk): ModelRow {
  let m: ModelRow = {
    id: ask.id, label: ask.label, apiName: ask.apiName, provider: ask.provider,
    kind: ask.kind, dimensions: ask.dimensions, baseUrl: ask.baseUrl,
    enabled: ask.enabled, contextTokens: ask.contextTokens };
  return m;
}

export function modelProblem(m: ModelRow): string {
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
@bindings
export class ModelApi {
  db: Db;
  master: string;
  constructor(db: Db, master: string) { this.db = db; this.master = master; }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [{ column: "label" }];
    return ok(listOrdered(this.db, modelsMapping(), { order: keys }));
  }

  @get("/choices")
  choices(req: Request): Reply {
    return ok(choicesJson(enabledChoices(this.db)));
  }

  @post("/")
  create(@Valid @RequestBody ask: ModelAsk): Reply {
    let document = JSON.stringify(ask);
    let problem = createProblem(this.db, modelsMapping(), document);
    if (problem != "") { return badRequest(problem); }
    let m = modelRowOf(ask);
    let wrong = modelProblem(m);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, m);
    if (moved != "") { return badRequest(moved); }
    let written = persist(this.db, modelsMapping(), document);
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, modelsMapping(), m.id));
  }

  @post("/:id/test")
  test(@PathVariable("id") id: string): Reply {
    let document = findById(this.db, modelsMapping(), id);
    if (document == "") { return notFound("model " + id); }
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
  update(@PathVariable("id") id: string, @Valid @RequestBody ask: ModelAsk): Reply {
    if (!existsById(this.db, modelsMapping(), id)) {
      return notFound("model " + id);
    }
    let row = modelRowOf(ask);
    if (row.id != id) {
      return badRequest("the id in the body must match the path");
    }
    let wrong = modelProblem(row);
    if (wrong != "") { return badRequest(wrong); }
    let moved = modelDestinationProblem(this.db, row);
    if (moved != "") { return badRequest(moved); }

    if (row.enabled && row.kind == "embedding") {
      executeWith(this.db, "UPDATE models SET enabled = " + this.db.placeholder
        + " WHERE kind = " + placeholderAt(this.db, 2)
        + " AND id <> " + placeholderAt(this.db, 3), ["0", "embedding", id]);
    }
    let written = persist(this.db, modelsMapping(), JSON.stringify(ask));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, modelsMapping(), id));
  }

  @del("/:id")
  remove(@PathVariable("id") id: string): Reply {
    if (!existsById(this.db, modelsMapping(), id)) {
      return notFound("model " + id);
    }
    if (countWhere(this.db, modelConfigsMapping(this.db), "model_id = " + this.db.placeholder, [id]) > 0) {
      return badRequest("model " + id + " is used by a model config; delete or repoint those first");
    }
    deleteById(this.db, modelsMapping(), id);
    return noContent();
  }
}

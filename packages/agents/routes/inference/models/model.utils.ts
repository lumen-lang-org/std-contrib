import { destinationOf } from "../../../credentials.ts";
import { chatEndpoint, embeddingEndpoint, endpointFor } from "../../../provider.ts";
import { MenuChoice } from "./dtos/menu-choice.dto.ts";
import { ModelAsk } from "./dtos/model-ask.dto.ts";
import { StoredModel } from "./dtos/stored-model.dto.ts";

export type ProbeConfig = {
  id: string,
  modelId: string,
  temperature: number,
  maxTokens: int,
  topP: number,
  extra: string,
  thinking: string,
  label: string,
  selectable: bool,
  rank: int,
};

export function choicesJson(rows: MenuChoice[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) {
      out = out + ",";
    }
    out = out + "{\"id\":" + JSON.stringify(rows[i].id)
      + ",\"label\":" + JSON.stringify(rows[i].label)
      + ",\"description\":" + JSON.stringify(rows[i].description)
      + ",\"kind\":" + JSON.stringify(rows[i].kind)
      + ",\"tier\":" + JSON.stringify(rows[i].tier) + "}";
    i = i + 1;
  }
  return out + "]";
}

export function storedModelOf(ask: ModelAsk): StoredModel {
  let row: StoredModel = {
    id: ask.id, label: ask.label, apiName: ask.apiName, provider: ask.provider,
    kind: ask.kind, dimensions: ask.dimensions, baseUrl: ask.baseUrl,
    enabled: ask.enabled, contextTokens: ask.contextTokens };
  return row;
}

export function modelFault(model: StoredModel): string {
  if (model.provider == "vertex" && model.baseUrl.trim() == "") {
    return "a vertex model needs its base URL — https://<region>-aiplatform.googleapis.com/v1/projects/<project>/locations/<region>/endpoints/openapi";
  }
  if (model.kind == "chat" && model.baseUrl.trim() == "" && chatEndpoint(model.provider) == "") {
    return "no chat endpoint for provider \"" + model.provider + "\"";
  }
  if (model.kind == "embedding" && model.baseUrl.trim() == "" && embeddingEndpoint(model.provider) == "") {
    return "no embedding endpoint for provider \"" + model.provider + "\"";
  }
  if (model.kind == "embedding" && model.dimensions <= 0) {
    return "an embedding model must say how wide its vectors are";
  }
  if (model.baseUrl.trim() != "" && destinationOf(model.baseUrl) == "") {
    return "a base URL is an http or https address, like \"https://gateway.internal/v1\" — not \"" + model.baseUrl + "\"";
  }
  return "";
}

export function modelDestination(model: StoredModel): string {
  if (model.kind == "embedding") {
    return endpointFor(model, "embeddings");
  }
  return endpointFor(model, "chat/completions");
}

export function authorisedModel(row: StoredModel): StoredModel {
  let held: StoredModel = {
    id: row.id, label: row.label, apiName: row.apiName, provider: row.provider,
    kind: row.kind, dimensions: row.dimensions, baseUrl: "", enabled: row.enabled,
    contextTokens: 0 };
  return held;
}

export function probeModel(stored: StoredModel): StoredModel {
  let model: StoredModel = {
    id: stored.id, label: stored.label, apiName: stored.apiName, provider: stored.provider,
    kind: stored.kind, dimensions: stored.dimensions, baseUrl: stored.baseUrl,
    enabled: true, contextTokens: 0 };
  return model;
}

export function probeConfig(modelId: string): ProbeConfig {
  let config: ProbeConfig = {
    id: "probe",
    modelId: modelId,
    temperature: 0,
    maxTokens: 16,
    topP: 1,
    extra: "",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  return config;
}

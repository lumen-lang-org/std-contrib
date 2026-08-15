import { Db } from "../../../../plume/driver.ts";
import { existsById } from "../../../../plume/plume.ts";
import { bodyBool, bodyInt, bodyJson, bodyNumber, bodyRank, bodyText } from "../../../api-core.ts";
import { modelRepository } from "../models/entities/model.entity.ts";
import { configAndModel } from "../../../schema.ts";
import { ModelConfigBody } from "./dtos/model-config-body.dto.ts";

/** Only what the body names changes; everything left out keeps what was stored. */
export function mergedConfig(stored: ModelConfigBody, body: string): ModelConfigBody {
  let out: ModelConfigBody = {
    id: stored.id,
    modelId: bodyText(body, "modelId", stored.modelId),
    temperature: bodyNumber(body, "temperature", stored.temperature),
    maxTokens: bodyInt(body, "maxTokens", stored.maxTokens),
    topP: bodyNumber(body, "topP", stored.topP),
    extra: bodyJson(body, "extra", stored.extra),
    thinking: bodyText(body, "thinking", stored.thinking),
    label: bodyText(body, "label", stored.label),
    selectable: bodyBool(body, "selectable", stored.selectable),
    rank: bodyRank(body, stored.rank),
  };
  return out;
}

export function configFault(db: Db, row: ModelConfigBody): string {
  if (row.modelId == "") {
    return "a modelId is required";
  }
  if (!existsById(db, modelRepository(), row.modelId)) {
    return "no model " + row.modelId + "; create it first";
  }
  if (row.maxTokens < 1) {
    return "maxTokens must be at least 1; a config that asks for no tokens cannot answer";
  }
  if (row.rank < 0) {
    return "menuRank cannot be negative";
  }
  return "";
}

/** A config that is going to answer a turn has to sit on a chat model.
 *
 *  Lives here rather than beside the choices and routers that ask it, because
 *  what it knows about is a model config. */
export function chatConfigFault(db: Db, configId: string, role: string): string {
  if (configId == "") {
    return role + " is required";
  }
  let pair = configAndModel(db, configId);
  if (pair.fault != "") {
    return role + ": " + pair.fault;
  }
  if (pair.model.kind != "chat") {
    return role + ": model config " + configId + " runs on a \"" + pair.model.kind
      + "\" model, and only a chat model can answer a turn";
  }
  return "";
}

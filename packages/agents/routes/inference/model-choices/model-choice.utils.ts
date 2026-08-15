import { Db } from "../../../../plume/driver.ts";
import { existsById } from "../../../../plume/plume.ts";
import { bodyBool, bodyRank, bodyText } from "../../../api-core.ts";
import { chatConfigFault } from "../model-configs/model-config.utils.ts";
import { modelRouterRepository } from "../models/entities/model-router.entity.ts";
import { ModelChoiceBody } from "./dtos/model-choice-body.dto.ts";

export function blankChoice(id: string): ModelChoiceBody {
  let out: ModelChoiceBody = {
    id: id, label: "", description: "", kind: "", configId: "", routerId: "",
    tier: "", enabled: true, rank: 0,
  };
  return out;
}

/** Only what the body names changes; everything left out keeps what was stored. */
export function mergedChoice(stored: ModelChoiceBody, body: string): ModelChoiceBody {
  let out: ModelChoiceBody = {
    id: stored.id,
    label: bodyText(body, "label", stored.label),
    description: bodyText(body, "description", stored.description),
    kind: bodyText(body, "kind", stored.kind),
    configId: bodyText(body, "configId", stored.configId),
    routerId: bodyText(body, "routerId", stored.routerId),
    tier: bodyText(body, "tier", stored.tier),
    enabled: bodyBool(body, "enabled", stored.enabled),
    rank: bodyRank(body, stored.rank),
  };
  return out;
}

export function choiceRowFault(db: Db, row: ModelChoiceBody): string {
  if (row.label == "") {
    return "a choice needs a label; it is the word in the menu";
  }
  if (row.tier != "" && row.tier != "premium") {
    return "tier is \"\" or \"premium\", not \"" + row.tier + "\"";
  }
  if (row.rank < 0) {
    return "menuRank cannot be negative";
  }
  if (row.kind == "config") {
    if (row.routerId != "") {
      return "a \"config\" choice carries no routerId; clear it, or set kind to \"router\"";
    }
    return chatConfigFault(db, row.configId, "configId");
  }
  if (row.kind == "router") {
    if (row.configId != "") {
      return "a \"router\" choice carries no configId; clear it, or set kind to \"config\"";
    }
    if (row.routerId == "") {
      return "routerId is required";
    }
    if (!existsById(db, modelRouterRepository(), row.routerId)) {
      return "no model router " + row.routerId + "; create it first";
    }
    return "";
  }
  return "kind is \"config\" or \"router\", not \"" + row.kind + "\"";
}

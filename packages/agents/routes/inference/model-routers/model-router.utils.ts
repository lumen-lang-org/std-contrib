import { Db } from "../../../../plume/driver.ts";
import { bodyBool, bodyText } from "../../../api-core.ts";
import { jsonMember } from "../../../../plume/plume.ts";
import { jsonList, jsonText } from "../../../scan.ts";
import { chatConfigFault } from "../model-configs/model-config.utils.ts";
import { CandidateView } from "./dtos/candidate-view.dto.ts";
import { ModelRouterBody } from "./dtos/model-router-body.dto.ts";

export function blankRouter(id: string): ModelRouterBody {
  let out: ModelRouterBody = {
    id: id, label: "", routerConfigId: "", candidatesJson: "[]",
    fallbackConfigId: "", routeEvery: "turn", escalateOnly: false, enabled: true,
  };
  return out;
}

export function bodyCandidates(body: string, fallback: string): string {
  let raw = jsonMember(body, "candidates");
  if (raw == "") {
    return fallback;
  }
  return raw;
}

/** The stored column is not the wire name, and sending it is a sign the caller
 *  is echoing back a row it read somewhere else. */
export function preEncodedCandidates(body: string): string {
  if (jsonMember(body, "candidatesJson") == "") {
    return "";
  }
  return "candidatesJson is not accepted here; send \"candidates\" as a JSON array of "
    + "{key, configId, when}";
}

/** Only what the body names changes; everything left out keeps what was stored. */
export function mergedRouter(stored: ModelRouterBody, body: string): ModelRouterBody {
  let out: ModelRouterBody = {
    id: stored.id,
    label: bodyText(body, "label", stored.label),
    routerConfigId: bodyText(body, "routerConfigId", stored.routerConfigId),
    candidatesJson: bodyCandidates(body, stored.candidatesJson),
    fallbackConfigId: bodyText(body, "fallbackConfigId", stored.fallbackConfigId),
    routeEvery: bodyText(body, "routeEvery", stored.routeEvery),
    escalateOnly: bodyBool(body, "escalateOnly", stored.escalateOnly),
    enabled: bodyBool(body, "enabled", stored.enabled),
  };
  return out;
}

export function candidatesFault(db: Db, candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text == "" || !text.startsWith("[")) {
    return "\"candidates\" must be a JSON array of {key, configId, when}";
  }
  let items = jsonList(text);
  if (items.length == 0) {
    return "a router needs at least one candidate; with none there is nothing for "
      + "the routing model to choose and every turn falls back";
  }
  let seen: string[] = [];
  let i: int = 0;
  while (i < items.length) {
    let item = items[i].trim();
    let at = "candidate " + `${i + 1}`;
    if (!item.startsWith("{")) {
      return at + " is not an object";
    }
    let key = jsonText(item, "key").trim();
    if (key == "") {
      return at + " has no \"key\"";
    }
    let folded = key.toLowerCase();
    let j: int = 0;
    while (j < seen.length) {
      if (seen[j] == folded) {
        return at + " repeats the key \"" + key + "\"; the router matches keys "
          + "without regard to case, so two of them are one";
      }
      j = j + 1;
    }
    seen.push(folded);
    let named = at + " (\"" + key + "\")";
    if (jsonText(item, "when").trim() == "") {
      return named + " has no \"when\"; a candidate with no description is a "
        + "candidate the routing model cannot choose on purpose";
    }
    let unusable = chatConfigFault(db, jsonText(item, "configId").trim(), named + " configId");
    if (unusable != "") {
      return unusable;
    }
    i = i + 1;
  }
  return "";
}

export function routerRowFault(db: Db, row: ModelRouterBody): string {
  if (row.label == "") {
    return "a router needs a label";
  }
  if (row.routeEvery != "turn" && row.routeEvery != "thread") {
    return "routeEvery is \"turn\" or \"thread\", not \"" + row.routeEvery + "\"";
  }
  let routing = chatConfigFault(db, row.routerConfigId, "routerConfigId");
  if (routing != "") {
    return routing;
  }
  let landing = chatConfigFault(db, row.fallbackConfigId, "fallbackConfigId");
  if (landing != "") {
    return landing;
  }
  if (!row.enabled) {
    return "";
  }
  return candidatesFault(db, row.candidatesJson);
}

function candidateView(item: string): CandidateView {
  let out: CandidateView = {
    key: jsonText(item, "key").trim(),
    configId: jsonText(item, "configId").trim(),
    when: jsonText(item, "when").trim(),
  };
  return out;
}

/** What is stored is the three members, trimmed — never whatever else arrived
 *  alongside them. */
export function withCanonicalCandidates(row: ModelRouterBody): ModelRouterBody {
  let items = jsonList(row.candidatesJson.trim());
  let out: ModelRouterBody = {
    id: row.id, label: row.label, routerConfigId: row.routerConfigId,
    candidatesJson: JSON.stringify(items.map(candidateView)), fallbackConfigId: row.fallbackConfigId,
    routeEvery: row.routeEvery, escalateOnly: row.escalateOnly, enabled: row.enabled,
  };
  return out;
}

function candidateArray(candidatesJson: string): string {
  let text = candidatesJson.trim();
  if (text.startsWith("[")) {
    return text;
  }
  return "[]";
}

/** The wire shape: candidatesJson goes out as a real array called
 *  "candidates". */
export function routerJson(row: ModelRouterBody): string {
  return "{\"id\":" + JSON.stringify(row.id)
    + ",\"label\":" + JSON.stringify(row.label)
    + ",\"routerConfigId\":" + JSON.stringify(row.routerConfigId)
    + ",\"fallbackConfigId\":" + JSON.stringify(row.fallbackConfigId)
    + ",\"routeEvery\":" + JSON.stringify(row.routeEvery)
    + ",\"escalateOnly\":" + `${row.escalateOnly}`
    + ",\"enabled\":" + `${row.enabled}`
    + ",\"candidates\":" + candidateArray(row.candidatesJson) + "}";
}

export function routersJson(rows: ModelRouterBody[]): string {
  let out = "[";
  let i: int = 0;
  while (i < rows.length) {
    if (i > 0) {
      out = out + ",";
    }
    out = out + routerJson(rows[i]);
    i = i + 1;
  }
  return out + "]";
}

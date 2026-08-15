import { toolCardFault } from "../../../api-core.ts";
import { CardCaseRow } from "../../../plugincards.ts";
import { jsonRaw } from "../../../scan.ts";
import { ToolCardRow } from "../../../toolcards.ts";
import { CardInput } from "./dtos/card-input.dto.ts";
import { CaseInput } from "./dtos/case-input.dto.ts";

export function rawListOr(body: string, member: string): string {
  let raw = jsonRaw(body, member);
  if (raw == "") {
    return "[]";
  }
  return raw;
}

export function cardsIn(body: string): CardInput[] {
  return JSON.parse<CardInput[]>(rawListOr(body, "cards"));
}

export function casesIn(body: string): CaseInput[] {
  return JSON.parse<CaseInput[]>(rawListOr(body, "cases"));
}

export function cardRowsOf(pluginId: string, inputs: CardInput[]): ToolCardRow[] {
  let rows: ToolCardRow[] = [];
  let i: int = 0;
  while (i < inputs.length) {
    let row: ToolCardRow = {
      id: pluginId + ":" + `${i}`,
      pluginId: pluginId,
      toolName: inputs[i].toolName,
      marker: inputs[i].marker,
      payload: inputs[i].payload,
      hint: inputs[i].hint,
      enabled: true,
    };
    rows.push(row);
    i = i + 1;
  }
  return rows;
}

export function caseRowsOf(pluginId: string, inputs: CaseInput[]): CardCaseRow[] {
  let rows: CardCaseRow[] = [];
  let i: int = 0;
  while (i < inputs.length) {
    let row: CardCaseRow = {
      id: pluginId + ":case:" + `${i}`,
      pluginId: pluginId,
      when: inputs[i].when,
      then: inputs[i].then,
    };
    rows.push(row);
    i = i + 1;
  }
  return rows;
}

export function firstCardFault(rows: ToolCardRow[]): string {
  let i: int = 0;
  while (i < rows.length) {
    let fault = toolCardFault(rows[i]);
    if (fault != "") {
      return fault;
    }
    i = i + 1;
  }
  return "";
}

export function manifestWithSource(manifest: string, url: string, rendererUrl: string,
                                   rendererSource: string): string {
  let trimmed = manifest.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  return "{\"sourceUrl\":" + JSON.stringify(url)
    + ",\"rendererUrl\":" + JSON.stringify(rendererUrl)
    + ",\"rendererSource\":" + JSON.stringify(rendererSource)
    + "," + trimmed.slice(1);
}

export function urlAgainst(base: string, ref: string): string {
  if (ref.startsWith("https://") || ref.startsWith("http://")) {
    return ref;
  }
  let cut = base.lastIndexOf("/");
  if (cut < 0) {
    return ref;
  }
  let directory = base.slice(0, cut);
  if (ref.startsWith("./")) {
    return directory + ref.slice(1);
  }
  return directory + "/" + ref;
}

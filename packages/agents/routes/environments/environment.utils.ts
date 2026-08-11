import { UserEnvRow } from "../../user-environments.ts";
import { EnvCatalogItem } from "./dtos/env-catalog-item.dto.ts";
import { ScriptImageView } from "./dtos/script-image-view.dto.ts";

export function ownCatalogItemOf(row: UserEnvRow, present: bool): EnvCatalogItem {
  let item: EnvCatalogItem = {
    id: row.id,
    label: row.name,
    summary: row.source == "dockerfile" ? "built from your Dockerfile" : row.image,
    mine: true,
    present: present,
  };
  return item;
}

export function sharedCatalogItemOf(row: ScriptImageView, present: bool): EnvCatalogItem {
  let item: EnvCatalogItem = {
    id: row.id,
    label: row.label,
    summary: row.summary,
    mine: false,
    present: present,
  };
  return item;
}

export function defaultCatalogItem(present: bool): EnvCatalogItem {
  let item: EnvCatalogItem = {
    id: "default",
    label: "Default",
    summary: "the image an agent gets when nobody chose one",
    mine: false,
    present: present,
  };
  return item;
}

import { Db } from "../plume/driver.ts";
import { DbOrder, DbRepository, createTableSql, deleteById, findById, listOrdered, persist } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { envTemplateRepository } from "./routes/sandbox/env-templates/entities/env-template.entity.ts";

export const MAX_TEMPLATE_NAME: int = 60;
export const MAX_TEMPLATE_SUMMARY: int = 400;
export const MAX_TEMPLATE_TAGS: int = 200;
export const MAX_TEMPLATE_DOCKERFILE: int = 16384;

export type EnvTemplateRow = {
  id: string,
  name: string,
  summary: string,
  tags: string,
  source: string,
  image: string,
  dockerfile: string,
  featuredRank: int,
  createdAt: string,
};

export function envTemplatesMapping(): DbRepository {
  return envTemplateRepository();
}

export function envTemplatesPlan(db: Db): Migration[] {
  return [
    migration("112", "env templates: the operator's catalog of environment recipes",
      createTableSql(db, envTemplatesMapping())),
  ];
}

export function emptyEnvTemplate(): EnvTemplateRow {
  let none: EnvTemplateRow = {
    id: "", name: "", summary: "", tags: "", source: "", image: "",
    dockerfile: "", featuredRank: 0, createdAt: "",
  };
  return none;
}

export function envTemplatesAll(db: Db): EnvTemplateRow[] {
  let keys: DbOrder[] = [{ column: "name" }];
  let listed = listOrdered(db, envTemplatesMapping(), { order: keys });
  if (listed == "" || listed == "[]") {
    let none: EnvTemplateRow[] = [];
    return none;
  }
  let rows = JSON.parse<EnvTemplateRow[]>(listed);
  let featured: EnvTemplateRow[] = [];
  let plain: EnvTemplateRow[] = [];
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].featuredRank > 0) {
      featured.push(rows[i]);
    } else {
      plain.push(rows[i]);
    }
    i = i + 1;
  }
  let maxRank: int = 0;
  let m: int = 0;
  while (m < featured.length) {
    if (featured[m].featuredRank > maxRank) {
      maxRank = featured[m].featuredRank;
    }
    m = m + 1;
  }
  let out: EnvTemplateRow[] = [];
  let r: int = 1;
  while (r <= maxRank) {
    let k: int = 0;
    while (k < featured.length) {
      if (featured[k].featuredRank == r) {
        out.push(featured[k]);
      }
      k = k + 1;
    }
    r = r + 1;
  }
  let b: int = 0;
  while (b < plain.length) {
    out.push(plain[b]);
    b = b + 1;
  }
  return out;
}

export function envTemplateById(db: Db, id: string): EnvTemplateRow {
  let doc = findById(db, envTemplatesMapping(), id);
  if (doc == "") {
    return emptyEnvTemplate();
  }
  return JSON.parse<EnvTemplateRow>(doc);
}

function cleanTags(raw: string): string {
  let parts = raw.split(",");
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim().toLowerCase();
    if (t != "") {
      out = out == "" ? t : out + "," + t;
    }
    i = i + 1;
  }
  return out;
}

export type EnvTemplateWrite = {
  id: string,
  name: string,
  summary: string,
  tags: string,
  image: string,
  dockerfile: string,
  featuredRank: int,
  now: string,
};

export function refuseEnvTemplate(t: EnvTemplateWrite): string {
  let name = t.name.trim();
  if (name == "") {
    return "a template needs a name — it is what the catalog shows";
  }
  if (name.length > MAX_TEMPLATE_NAME) {
    return "\"" + name.slice(0, 20) + "...\" is too long a name";
  }
  if (t.summary.length > MAX_TEMPLATE_SUMMARY) {
    return "that description is " + `${t.summary.length}` + " characters — the most a card holds is " + `${MAX_TEMPLATE_SUMMARY}`;
  }
  if (t.tags.length > MAX_TEMPLATE_TAGS) {
    return "that is a lot of tags — keep them under " + `${MAX_TEMPLATE_TAGS}` + " characters";
  }
  let img = t.image.trim();
  let df = t.dockerfile.trim();
  if (img == "" && df == "") {
    return "a template is an image or a Dockerfile — one of the two is required";
  }
  if (img != "" && df != "") {
    return "an image or a Dockerfile, not both — the Dockerfile builds the image";
  }
  if (df != "" && df.length > MAX_TEMPLATE_DOCKERFILE) {
    return "that Dockerfile is " + `${df.length}` + " characters — the most a template takes is " + `${MAX_TEMPLATE_DOCKERFILE}`;
  }
  if (df != "" && df.toUpperCase().indexOf("FROM") < 0) {
    return "a Dockerfile starts FROM something";
  }
  if (t.featuredRank < 0) {
    return "featuredRank is 0 (not featured) or a positive position";
  }
  return "";
}

export function saveEnvTemplate(db: Db, t: EnvTemplateWrite): string {
  let wrong = refuseEnvTemplate(t);
  if (wrong != "") {
    return wrong;
  }
  let id = t.id.trim() == "" ? crypto.randomUUID() : t.id.trim();
  let prior = findById(db, envTemplatesMapping(), id);
  let createdAt = t.now;
  if (prior != "") {
    createdAt = JSON.parse<EnvTemplateRow>(prior).createdAt;
  }
  let row: EnvTemplateRow = {
    id: id,
    name: t.name.trim(),
    summary: t.summary.trim(),
    tags: cleanTags(t.tags),
    source: t.image.trim() != "" ? "image" : "dockerfile",
    image: t.image.trim(),
    dockerfile: t.dockerfile.trim(),
    featuredRank: t.featuredRank,
    createdAt: createdAt,
  };
  let written = persist(db, envTemplatesMapping(), JSON.stringify(row));
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function forgetEnvTemplate(db: Db, id: string): bool {
  if (findById(db, envTemplatesMapping(), id) == "") {
    return false;
  }
  return deleteById(db, envTemplatesMapping(), id).ok;
}

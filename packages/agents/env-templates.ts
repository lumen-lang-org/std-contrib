// The catalog of environment templates an operator curates.
//
// A template is a recipe, not a container: a name, a sentence of what it is
// for, some tags to find it by, and either an image reference or a Dockerfile.
// It runs nothing. When a person picks one, `/environments` builds THEIR own
// environment from its image or Dockerfile — the template is the recipe, the
// environment is the instance, and one template seeds many people's copies.
//
// Curated by the operator, exactly like script_images and for the same
// reason: a Dockerfile is code that builds as root on the sandbox daemon, so
// the person who writes the catalog's recipes is the operator, and everyone
// else picks from what they wrote. (User-published templates are a larger
// feature with a scan gate in front of it — deliberately not this.)
//
// Deployment-global: a template has no owner, because it is offered to
// everyone. The environments it seeds are owned; the recipe is shared.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, persist, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export const MAX_TEMPLATE_NAME: int = 60;
export const MAX_TEMPLATE_SUMMARY: int = 400;
export const MAX_TEMPLATE_TAGS: int = 200;
// The same ceiling a user Dockerfile has — a recipe is not a repository.
export const MAX_TEMPLATE_DOCKERFILE: int = 16384;

export type EnvTemplateRow = {
  id: string,
  // What it is called where somebody browses the catalog.
  name: string,
  // One line: what is inside and what it is for. Shown on the card and copied
  // into the environment's summary when someone instantiates it.
  summary: string,
  // Comma-separated, lowercased on the way in: "python,data,pandas". What the
  // catalog filters and groups by.
  tags: string,
  // "image" (pulled as given) or "dockerfile" (built when instantiated).
  source: string,
  image: string,
  dockerfile: string,
  // 0 = an ordinary catalog entry; a positive number pins it to the front, in
  // ascending order, the way a featured skill is pinned.
  featuredRank: int,
  createdAt: string,
};

export function envTemplatesMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("name", "name", "text"),
    field("summary", "summary", "text"),
    field("tags", "tags", "text"),
    field("source", "source", "text"),
    field("image", "image", "text"),
    field("dockerfile", "dockerfile", "text"),
    field("featuredRank", "featured_rank", "int"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("env_templates", "id", "id", fs);
}

export function envTemplatesPlan(db: Db): Migration[] {
  // 112: user-environments.ts owns 111.
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

// Featured first (ascending rank), then everyone else by name. One order for
// the whole catalog, so browse and pick agree on what "first" means.
export function envTemplatesAll(db: Db): EnvTemplateRow[] {
  let keys: DbOrder[] = [asc("name")];
  let listed = listOrdered(db, envTemplatesMapping(), "", [], keys);
  if (listed == "" || listed == "[]") {
    let none: EnvTemplateRow[] = [];
    return none;
  }
  let rows = JSON.parse<EnvTemplateRow[]>(listed);
  // Featured rows to the front, in rank order, keeping the name order among
  // the rest. A stable partition rather than a second ORDER BY, because
  // "featured then alphabetical" is two sorts SQL cannot express in one key
  // without a computed column.
  let featured: EnvTemplateRow[] = [];
  let plain: EnvTemplateRow[] = [];
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].featuredRank > 0) { featured.push(rows[i]); } else { plain.push(rows[i]); }
    i = i + 1;
  }
  // Emit the featured in ascending rank without mutating an array — Lumen's
  // are immutable, so no in-place sort. Ranks are a handful of small positive
  // numbers, so walking rank 1..max and pushing every match is both correct
  // and the clearest thing: ties keep the name order the SQL already gave.
  let maxRank: int = 0;
  let m: int = 0;
  while (m < featured.length) {
    if (featured[m].featuredRank > maxRank) { maxRank = featured[m].featuredRank; }
    m = m + 1;
  }
  let out: EnvTemplateRow[] = [];
  let r: int = 1;
  while (r <= maxRank) {
    let k: int = 0;
    while (k < featured.length) {
      if (featured[k].featuredRank == r) { out.push(featured[k]); }
      k = k + 1;
    }
    r = r + 1;
  }
  let b: int = 0;
  while (b < plain.length) { out.push(plain[b]); b = b + 1; }
  return out;
}

export function envTemplateById(db: Db, id: string): EnvTemplateRow {
  let doc = findById(db, envTemplatesMapping(), id);
  if (doc == "") { return emptyEnvTemplate(); }
  return JSON.parse<EnvTemplateRow>(doc);
}

// Lowercased, comma-separated, no empty tags — the shape the catalog filters
// on, normalised once here rather than at every read.
function cleanTags(raw: string): string {
  let parts = raw.split(",");
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim().toLowerCase();
    if (t != "") { out = out == "" ? t : out + "," + t; }
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

/** Why this template cannot be written, or "". The same image-XOR-Dockerfile
 *  rule a user environment has, because a template that could not be
 *  instantiated is a card that only ever errors. */
export function refuseEnvTemplate(t: EnvTemplateWrite): string {
  let name = t.name.trim();
  if (name == "") { return "a template needs a name — it is what the catalog shows"; }
  if (name.length > MAX_TEMPLATE_NAME) { return "\"" + name.slice(0, 20) + "...\" is too long a name"; }
  if (t.summary.length > MAX_TEMPLATE_SUMMARY) {
    return "that description is " + `${t.summary.length}` + " characters — the most a card holds is " + `${MAX_TEMPLATE_SUMMARY}`;
  }
  if (t.tags.length > MAX_TEMPLATE_TAGS) { return "that is a lot of tags — keep them under " + `${MAX_TEMPLATE_TAGS}` + " characters"; }
  let img = t.image.trim();
  let df = t.dockerfile.trim();
  if (img == "" && df == "") { return "a template is an image or a Dockerfile — one of the two is required"; }
  if (img != "" && df != "") { return "an image or a Dockerfile, not both — the Dockerfile builds the image"; }
  if (df != "" && df.length > MAX_TEMPLATE_DOCKERFILE) {
    return "that Dockerfile is " + `${df.length}` + " characters — the most a template takes is " + `${MAX_TEMPLATE_DOCKERFILE}`;
  }
  if (df != "" && df.toUpperCase().indexOf("FROM") < 0) { return "a Dockerfile starts FROM something"; }
  if (t.featuredRank < 0) { return "featuredRank is 0 (not featured) or a positive position"; }
  return "";
}

/** Write a template — create or update, keyed by id. The catalog is small and
 *  operator-owned, so there is no per-owner cap and no uniqueness beyond the
 *  id: two templates may share a name if an operator wants a "python (slim)"
 *  and a "python (full)". */
export function saveEnvTemplate(db: Db, t: EnvTemplateWrite): string {
  let wrong = refuseEnvTemplate(t);
  if (wrong != "") { return wrong; }
  let id = t.id.trim() == "" ? crypto.randomUUID() : t.id.trim();
  let prior = findById(db, envTemplatesMapping(), id);
  let createdAt = t.now;
  if (prior != "") { createdAt = JSON.parse<EnvTemplateRow>(prior).createdAt; }
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
  if (!written.ok) { return written.error; }
  return "";
}

/** Remove a template. The environments it already seeded are untouched — they
 *  are their owners' now, built from an image the template only pointed at. */
export function forgetEnvTemplate(db: Db, id: string): bool {
  if (findById(db, envTemplatesMapping(), id) == "") { return false; }
  deleteById(db, envTemplatesMapping(), id);
  return true;
}

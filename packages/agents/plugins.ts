// Installing somebody else's bundle.
//
// A plugin is the third noun beside a skill and a connector, and the split is
// about how a thing is ACQUIRED rather than what it does: you write a skill,
// you address a connector, and a plugin you install from a manifest somebody
// else publishes. Claude's directory draws the same three; ours had two of
// them filed under one wrong name for a month.
//
// The install itself is deliberately unglamorous. It reads a JSON document,
// writes ordinary rows into `skills` and `mcp_servers`, and records what it
// wrote in `plugin_items`. Nothing downstream learns a new concept: use_skill
// resolves the skill it created exactly as it resolves one typed into the
// settings form, and the tool loop mounts the connector the same way. The
// plugin row is a receipt, and the receipt is what makes an uninstall possible
// — without it, removing a bundle means guessing which rows came from it.
//
// The manifest is read leniently, with scan.ts rather than `JSON.parse<T>`.
// That is not laziness: JSON.parse refuses a document that carries a member
// the record does not declare, so a publisher adding one field to their own
// manifest would break every installer that had ever worked. A format other
// people write has to tolerate members we do not know about.

import { Db } from "../plume/driver.ts";
import { persist, listWhere, deleteById, countWhere, placeholderAt } from "../plume/plume.ts";
import { PluginRow, PluginItemRow, SkillRow, SkillFileRow, McpServerRow, pluginsMapping, pluginItemsMapping, skillsMapping, skillFilesMapping, mcpServersMapping } from "./schema.ts";
import { jsonRaw, jsonText, jsonList } from "./scan.ts";
import { scriptEnvNameProblem } from "./run-script.ts";

// A file a manifest's skill ships.
export type SeedFile = {
  path: string,
  body: string,
};

export type SkillSeed = {
  skillName: string,
  description: string,
  body: string,
  files: SeedFile[],
};

export type ConnectorSeed = {
  serverName: string,
  transport: string,
  endpoint: string,
  authKind: string,
  authHeader: string,
};

// A manifest, read. `problem` non-empty means nothing in the other fields is
// worth looking at.
export type Manifest = {
  problem: string,
  pluginName: string,
  description: string,
  version: string,
  skills: SkillSeed[],
  connectors: ConnectorSeed[],
};

function failedManifest(why: string): Manifest {
  let bad: Manifest = { problem: why, pluginName: "", description: "", version: "",
    skills: [], connectors: [] };
  return bad;
}

// The document with a member's value cut out of it.
//
// jsonFind answers the FIRST occurrence of a key anywhere in the document,
// nesting included — so a manifest whose top-level "description" comes after
// its skills array would read a skill's description as the plugin's. Removing
// the arrays before reading the scalars makes "first" mean "top level", which
// is what every reader here assumes.
function without(document: string, raw: string): string {
  if (raw == "") { return document; }
  let at = document.indexOf(raw);
  if (at < 0) { return document; }
  return document.slice(0, at) + "\"\"" + document.slice(at + raw.length);
}

export function manifestFrom(document: string): Manifest {
  if (document.trim() == "") { return failedManifest("that URL answered with nothing"); }
  if (!document.trim().startsWith("{")) {
    // The usual way this fails is a GitHub *page* URL rather than a raw one:
    // the answer is HTML, 200, and utterly unparseable. Saying so beats "not
    // valid JSON", which sends people to look at their manifest.
    return failedManifest("that URL answered with something that is not a JSON manifest — a GitHub page URL answers HTML; use the raw one");
  }
  let skillsRaw = jsonRaw(document, "skills");
  let connectorsRaw = jsonRaw(document, "connectors");
  let head = without(without(document, skillsRaw), connectorsRaw);

  let name = jsonText(head, "name");
  if (name.trim() == "") { return failedManifest("a manifest needs a \"name\""); }
  let named = scriptEnvNameProblem(name);
  if (named != "") {
    return failedManifest("\"" + name + "\" cannot be a plugin name: " + named);
  }

  let skills: SkillSeed[] = [];
  let items = jsonList(skillsRaw);
  let i: int = 0;
  while (i < items.length) {
    let one = items[i];
    let filesRaw = jsonRaw(one, "files");
    let bare = without(one, filesRaw);
    let files: SeedFile[] = [];
    let raws = jsonList(filesRaw);
    let f: int = 0;
    while (f < raws.length) {
      let file: SeedFile = { path: jsonText(raws[f], "path"), body: jsonText(raws[f], "body") };
      if (file.path.trim() == "") { return failedManifest("a skill file needs a \"path\""); }
      // The same guard the skill-files route keeps, for the same reason: this
      // path is joined into a container path, and a manifest is written by
      // somebody who is not us.
      if (file.path.indexOf("/") >= 0 || file.path.indexOf("..") >= 0) {
        return failedManifest("a skill file is a plain name; \"" + file.path + "\" is a path");
      }
      files.push(file);
      f = f + 1;
    }
    let seed: SkillSeed = {
      skillName: jsonText(bare, "name"),
      description: jsonText(bare, "description"),
      body: jsonText(bare, "body"),
      files: files,
    };
    if (seed.skillName.trim() == "") { return failedManifest("every skill in a manifest needs a \"name\""); }
    let ok = scriptEnvNameProblem(seed.skillName);
    if (ok != "") { return failedManifest("skill \"" + seed.skillName + "\": " + ok); }
    if (seed.description.trim() == "") {
      return failedManifest("skill \"" + seed.skillName + "\" has no description, so nothing could choose it");
    }
    if (seed.body.trim() == "") {
      return failedManifest("skill \"" + seed.skillName + "\" has an empty body");
    }
    skills.push(seed);
    i = i + 1;
  }

  let connectors: ConnectorSeed[] = [];
  let cons = jsonList(connectorsRaw);
  let c: int = 0;
  while (c < cons.length) {
    let one = cons[c];
    let kind = jsonText(one, "authKind");
    if (kind == "") { kind = "none"; }
    let conn: ConnectorSeed = {
      serverName: jsonText(one, "name"),
      transport: "http",
      endpoint: jsonText(one, "endpoint"),
      authKind: kind,
      authHeader: jsonText(one, "authHeader"),
    };
    if (conn.serverName.trim() == "") { return failedManifest("every connector in a manifest needs a \"name\""); }
    if (conn.endpoint.trim() == "") {
      return failedManifest("connector \"" + conn.serverName + "\" has no endpoint");
    }
    if (kind != "none" && kind != "bearer" && kind != "header") {
      return failedManifest("connector \"" + conn.serverName + "\": authKind is none, bearer or header");
    }
    connectors.push(conn);
    c = c + 1;
  }

  if (skills.length == 0 && connectors.length == 0) {
    return failedManifest("that manifest installs nothing — no skills and no connectors");
  }
  let read: Manifest = {
    problem: "",
    pluginName: name,
    description: jsonText(head, "description"),
    version: jsonText(head, "version"),
    skills: skills,
    connectors: connectors,
  };
  return read;
}

// The manifest at a URL.
//
// One redirect-free GET, because a manifest is a static file. A `github.com`
// blob URL is rewritten to raw.githubusercontent rather than refused: it is
// the URL a person has in their clipboard, and the alternative is teaching
// everyone the raw form by way of an error message.
export function manifestUrl(url: string): string {
  let at = url.trim();
  if (at.startsWith("https://github.com/") && at.indexOf("/blob/") > 0) {
    return "https://raw.githubusercontent.com"
      + at.slice("https://github.com".length).replaceAll("/blob/", "/");
  }
  return at;
}

export type Fetched = {
  problem: string,
  body: string,
};

export function fetchManifest(url: string): Fetched {
  let where = manifestUrl(url);
  if (!where.startsWith("http://") && !where.startsWith("https://")) {
    let bad: Fetched = { problem: "a plugin is installed from an http(s) URL", body: "" };
    return bad;
  }
  let headers = new Map<string, string>();
  headers.set("accept", "application/json");
  let res = http.request(where, "GET", "", headers);
  if (!res.ok) {
    let dead: Fetched = { problem: "could not reach " + where, body: "" };
    return dead;
  }
  if (res.status != 200) {
    let refused: Fetched = { problem: where + " answered HTTP " + `${res.status}`, body: "" };
    return refused;
  }
  let got: Fetched = { problem: "", body: res.body };
  return got;
}

// What an install would collide with, in words, or "".
//
// Checked before anything is written rather than repaired afterwards. A
// half-installed plugin — three skills in, the fourth name taken — leaves rows
// nobody asked for and a receipt that does not match them, and there is no
// transaction here to lean on.
export function installProblem(db: Db, m: Manifest): string {
  if (countWhere(db, pluginsMapping(), "plugin_name = " + placeholderAt(db, 1), [m.pluginName]) > 0) {
    return "\"" + m.pluginName + "\" is already installed — remove it first to install it again";
  }
  let i: int = 0;
  while (i < m.skills.length) {
    if (countWhere(db, skillsMapping(), "skill_name = " + placeholderAt(db, 1), [m.skills[i].skillName]) > 0) {
      return "a skill called \"" + m.skills[i].skillName + "\" already exists here; rename it, or remove it, before installing this plugin";
    }
    i = i + 1;
  }
  let c: int = 0;
  while (c < m.connectors.length) {
    if (countWhere(db, mcpServersMapping(), "server_name = " + placeholderAt(db, 1), [m.connectors[c].serverName]) > 0) {
      return "a connector called \"" + m.connectors[c].serverName + "\" already exists here";
    }
    c = c + 1;
  }
  return "";
}

function receipt(db: Db, pluginId: string, kind: string, itemId: string): void {
  let row: PluginItemRow = { id: crypto.randomUUID(), pluginId: pluginId, kind: kind, itemId: itemId };
  persist(db, pluginItemsMapping(), JSON.stringify(row));
}

// Write the bundle. `installProblem` has already answered "" for this db.
//
// Skills arrive PRIVATE and connectors arrive DISABLED, which is the same rule
// the ready-made connector shelf keeps: installing something is interest, not
// trust. A connector that needs a token would otherwise fail every call from
// the moment it landed, and a public skill would join every user's briefing
// because one operator tried a bundle out.
//
// source is 'repo' and sourceUrl is the manifest: a plugin's skill is edited
// where the plugin is published, and the skills route already refuses the
// write and points at "copy to local". That is not a new rule for plugins; it
// is the rule for anything this deployment did not write, reused.
export function install(db: Db, m: Manifest, sourceUrl: string, now: string): PluginRow {
  let plugin: PluginRow = {
    id: crypto.randomUUID(),
    pluginName: m.pluginName,
    description: m.description,
    sourceUrl: sourceUrl,
    version: m.version,
    installedAt: now,
  };
  persist(db, pluginsMapping(), JSON.stringify(plugin));

  let i: int = 0;
  while (i < m.skills.length) {
    let seed = m.skills[i];
    let skill: SkillRow = {
      id: crypto.randomUUID(),
      skillName: seed.skillName,
      description: seed.description,
      body: seed.body,
      updatedAt: now,
      visibility: "private",
      featuredRank: 0,
      source: "repo",
      sourceUrl: sourceUrl,
    };
    persist(db, skillsMapping(), JSON.stringify(skill));
    receipt(db, plugin.id, "skill", skill.id);
    let f: int = 0;
    while (f < seed.files.length) {
      let file: SkillFileRow = {
        id: crypto.randomUUID(),
        skillId: skill.id,
        path: seed.files[f].path,
        body: seed.files[f].body,
      };
      persist(db, skillFilesMapping(), JSON.stringify(file));
      f = f + 1;
    }
    i = i + 1;
  }

  let c: int = 0;
  while (c < m.connectors.length) {
    let seed = m.connectors[c];
    let server: McpServerRow = {
      id: crypto.randomUUID(),
      serverName: seed.serverName,
      transport: "http",
      endpoint: seed.endpoint,
      authKind: seed.authKind,
      authHeader: seed.authHeader,
      enabled: false,
    };
    persist(db, mcpServersMapping(), JSON.stringify(server));
    receipt(db, plugin.id, "connector", server.id);
    c = c + 1;
  }
  return plugin;
}

// What a plugin brought, as rows.
export function itemsOf(db: Db, pluginId: string): PluginItemRow[] {
  let held = listWhere(db, pluginItemsMapping(), "plugin_id = " + placeholderAt(db, 1), [pluginId]);
  if (held == "" || held == "[]") {
    let none: PluginItemRow[] = [];
    return none;
  }
  return JSON.parse<PluginItemRow[]>(held);
}

// Take the bundle back out.
//
// Only what the receipts name. A skill somebody copied to local afterwards is
// a different row with no receipt and survives on purpose — the copy exists
// precisely because they wanted to keep it — and a connector they re-pointed
// at their own endpoint goes, because it is still the row the plugin created
// and leaving it would leave a server nobody can account for.
export function uninstall(db: Db, pluginId: string): void {
  let items = itemsOf(db, pluginId);
  let i: int = 0;
  while (i < items.length) {
    if (items[i].kind == "skill") {
      let files = listWhere(db, skillFilesMapping(), "skill_id = " + placeholderAt(db, 1), [items[i].itemId]);
      if (files != "" && files != "[]") {
        let rows: SkillFileRow[] = JSON.parse<SkillFileRow[]>(files);
        let f: int = 0;
        while (f < rows.length) {
          deleteById(db, skillFilesMapping(), rows[f].id);
          f = f + 1;
        }
      }
      deleteById(db, skillsMapping(), items[i].itemId);
    }
    if (items[i].kind == "connector") {
      deleteById(db, mcpServersMapping(), items[i].itemId);
    }
    deleteById(db, pluginItemsMapping(), items[i].id);
    i = i + 1;
  }
  deleteById(db, pluginsMapping(), pluginId);
}

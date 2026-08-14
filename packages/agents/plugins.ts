import { Db } from "../plume/driver.ts";
import { persist, listWhere, deleteById, countWhere, placeholderAt } from "../plume/plume.ts";
import { PluginRow, PluginItemRow, SkillRow, SkillFileRow, McpServerRow, pluginsMapping, pluginItemsMapping, skillsMapping, skillFilesMapping, mcpServersMapping } from "./schema.ts";
import { jsonRaw, jsonText, jsonList } from "./scan.ts";
import { scriptEnvNameFault } from "./run-script.ts";

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

export type Manifest = {
  fault: string,
  pluginName: string,
  description: string,
  version: string,
  skills: SkillSeed[],
  connectors: ConnectorSeed[],
};

function failedManifest(why: string): Manifest {
  let bad: Manifest = { fault: why, pluginName: "", description: "", version: "",
    skills: [], connectors: [] };
  return bad;
}

function without(document: string, raw: string): string {
  if (raw == "") {
    return document;
  }
  let at = document.indexOf(raw);
  if (at < 0) {
    return document;
  }
  return document.slice(0, at) + "\"\"" + document.slice(at + raw.length);
}

export function manifestFrom(document: string): Manifest {
  if (document.trim() == "") {
    return failedManifest("that URL answered with nothing");
  }
  if (!document.trim().startsWith("{")) {
    return failedManifest("that URL answered with something that is not a JSON manifest — a GitHub page URL answers HTML; use the raw one");
  }
  let skillsRaw = jsonRaw(document, "skills");
  let connectorsRaw = jsonRaw(document, "connectors");
  let head = without(without(document, skillsRaw), connectorsRaw);

  let name = jsonText(head, "name");
  if (name.trim() == "") {
    return failedManifest("a manifest needs a \"name\"");
  }
  let named = scriptEnvNameFault(name);
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
      if (file.path.trim() == "") {
        return failedManifest("a skill file needs a \"path\"");
      }
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
    if (seed.skillName.trim() == "") {
      return failedManifest("every skill in a manifest needs a \"name\"");
    }
    let ok = scriptEnvNameFault(seed.skillName);
    if (ok != "") {
      return failedManifest("skill \"" + seed.skillName + "\": " + ok);
    }
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
    if (kind == "") {
      kind = "none";
    }
    let conn: ConnectorSeed = {
      serverName: jsonText(one, "name"),
      transport: "http",
      endpoint: jsonText(one, "endpoint"),
      authKind: kind,
      authHeader: jsonText(one, "authHeader"),
    };
    if (conn.serverName.trim() == "") {
      return failedManifest("every connector in a manifest needs a \"name\"");
    }
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
    fault: "",
    pluginName: name,
    description: jsonText(head, "description"),
    version: jsonText(head, "version"),
    skills: skills,
    connectors: connectors,
  };
  return read;
}

export function manifestUrl(url: string): string {
  let at = url.trim();
  if (at.startsWith("https://github.com/") && at.indexOf("/blob/") > 0) {
    return "https://raw.githubusercontent.com"
      + at.slice("https://github.com".length).replaceAll("/blob/", "/");
  }
  return at;
}

export type Fetched = {
  fault: string,
  body: string,
};

export function fetchManifest(url: string): Fetched {
  let where = manifestUrl(url);
  if (!where.startsWith("http://") && !where.startsWith("https://")) {
    let bad: Fetched = { fault: "a plugin is installed from an http(s) URL", body: "" };
    return bad;
  }
  let headers = new Map<string, string>();
  headers.set("accept", "application/json");
  let res = http.request(where, "GET", "", headers);
  if (!res.ok) {
    let dead: Fetched = { fault: "could not reach " + where, body: "" };
    return dead;
  }
  if (res.status != 200) {
    let refused: Fetched = { fault: where + " answered HTTP " + `${res.status}`, body: "" };
    return refused;
  }
  let got: Fetched = { fault: "", body: res.body };
  return got;
}

export function installFault(db: Db, m: Manifest): string {
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
  let row: PluginItemRow = {
    id: crypto.randomUUID(),
    pluginId: pluginId,
    kind: kind,
    itemId: itemId,
  };
  persist(db, pluginItemsMapping(), JSON.stringify(row));
}

function emptyPlugin(): PluginRow {
  let none: PluginRow = {
    id: "",
    pluginName: "",
    description: "",
    sourceUrl: "",
    version: "",
    installedAt: "",
  };
  return none;
}

export function install(db: Db, m: Manifest, sourceUrl: string, now: string): PluginRow {
  let plugin: PluginRow = {
    id: crypto.randomUUID(),
    pluginName: m.pluginName,
    description: m.description,
    sourceUrl: sourceUrl,
    version: m.version,
    installedAt: now,
  };
  let written = persist(db, pluginsMapping(), JSON.stringify(plugin));
  if (!written.ok) {
    return emptyPlugin();
  }

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

export function itemsOf(db: Db, pluginId: string): PluginItemRow[] {
  let held = listWhere(db, pluginItemsMapping(), "plugin_id = " + placeholderAt(db, 1), [pluginId]);
  if (held == "" || held == "[]") {
    let none: PluginItemRow[] = [];
    return none;
  }
  return JSON.parse<PluginItemRow[]>(held);
}

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

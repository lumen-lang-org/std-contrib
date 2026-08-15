import { jsonRaw, jsonText, jsonList } from "../../../scan.ts";
import { scriptEnvNameFault } from "../../../run-script.ts";
import { ManifestConnectorView } from "./dtos/manifest-connector-view.dto.ts";
import { ManifestSkillView } from "./dtos/manifest-skill-view.dto.ts";
import { ManifestView } from "./dtos/manifest-view.dto.ts";

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

export type PluginRow = {
  id: string,
  pluginName: string,
  description: string,
  sourceUrl: string,
  version: string,
  installedAt: string,
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

export function manifestView(manifest: Manifest, clash: string): ManifestView {
  let skills: ManifestSkillView[] = [];
  let i: int = 0;
  while (i < manifest.skills.length) {
    let one: ManifestSkillView = {
      name: manifest.skills[i].skillName,
      description: manifest.skills[i].description,
      files: manifest.skills[i].files.length,
    };
    skills.push(one);
    i = i + 1;
  }
  let connectors: ManifestConnectorView[] = [];
  let c: int = 0;
  while (c < manifest.connectors.length) {
    let link: ManifestConnectorView = {
      name: manifest.connectors[c].serverName,
      endpoint: manifest.connectors[c].endpoint,
      authKind: manifest.connectors[c].authKind,
    };
    connectors.push(link);
    c = c + 1;
  }
  let view: ManifestView = {
    name: manifest.pluginName,
    description: manifest.description,
    version: manifest.version,
    fault: clash,
    skills: skills,
    connectors: connectors,
  };
  return view;
}

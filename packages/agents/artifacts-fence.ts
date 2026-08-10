import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";
import { ARTIFACT_MAX, ArtifactRow, getVersion, kindOf, listArtifacts, putArtifact, utf8Length } from "./artifacts.ts";
import { normalScope } from "./knowledge.ts";

export const REPLY_FENCES_MAX: int = 8;
export const REPLY_EXTRACT_MAX: int = 2097152;

export const CLAIMED_SAVE: string = "(claimed save — nothing was written)";

export type FencedFile = {
  lang: string,
  path: string,
  title: string,
  body: string,
  open: int,
  bodyAt: int,
  close: int,
  closeEnd: int,
};

export type FenceHint = {
  lang: string,
  path: string,
  title: string,
};

function lineEnd(text: string, from: int): int {
  let i = from;
  while (i < text.length && text.charAt(i) != "\n") {
    i = i + 1;
  }
  return i;
}

function runLength(text: string, at: int, mark: string): int {
  let i = at;
  while (i < text.length && text.charAt(i) == mark) {
    i = i + 1;
  }
  return i - at;
}

function infoBlank(ch: string): bool {
  return ch == " " || ch == "\t" || ch == "\r";
}

export function fenceHint(info: string): FenceHint {
  let lang = "";
  let path = "";
  let title = "";
  let first = true;
  let i: int = 0;
  while (i < info.length) {
    while (i < info.length && infoBlank(info.charAt(i))) {
      i = i + 1;
    }
    if (i >= info.length) {
      break;
    }
    let ws = i;
    while (i < info.length) {
      let ch = info.charAt(i);
      if (infoBlank(ch) || ch == "=" || ch == ":") {
        break;
      }
      i = i + 1;
    }
    let word = info.slice(ws, i);
    let at = i;
    while (at < info.length && infoBlank(info.charAt(at))) {
      at = at + 1;
    }
    let sep = at < info.length ? info.charAt(at) : "";
    let keyed = (sep == "=" || sep == ":") && (word == "path" || word == "title");
    if (!keyed) {
      if (first && word != "") {
        lang = word;
      }
      first = false;
      while (i < info.length && !infoBlank(info.charAt(i))) {
        i = i + 1;
      }
      continue;
    }
    first = false;
    i = at + 1;
    while (i < info.length && infoBlank(info.charAt(i))) {
      i = i + 1;
    }
    let value = "";
    if (i < info.length && info.charAt(i) == "\"") {
      i = i + 1;
      let vs = i;
      while (i < info.length && info.charAt(i) != "\"") {
        i = i + 1;
      }
      value = info.slice(vs, i);
      if (i < info.length) {
        i = i + 1;
      }
    } else if (word == "title") {
      value = info.slice(i, info.length);
      while (value.length > 0 && infoBlank(value.charAt(value.length - 1))) {
        value = value.slice(0, value.length - 1);
      }
      i = info.length;
    } else {
      let vs = i;
      while (i < info.length && !infoBlank(info.charAt(i))) {
        i = i + 1;
      }
      value = info.slice(vs, i);
    }
    if (word == "path") {
      path = value;
    } else {
      title = value;
    }
  }
  let out: FenceHint = { lang: lang, path: path, title: title };
  return out;
}

function closesFence(text: string, from: int, end: int, mark: string, n: int): bool {
  let i = from;
  let spaces: int = 0;
  while (i < end && text.charAt(i) == " " && spaces < 3) {
    i = i + 1;
    spaces = spaces + 1;
  }
  let run = runLength(text, i, mark);
  if (run < n) {
    return false;
  }
  i = i + run;
  while (i < end) {
    if (!infoBlank(text.charAt(i))) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function fencedFiles(text: string): FencedFile[] {
  let out: FencedFile[] = [];
  let i: int = 0;
  while (i < text.length) {
    let end = lineEnd(text, i);
    let j = i;
    let spaces: int = 0;
    while (j < end && text.charAt(j) == " " && spaces < 3) {
      j = j + 1;
      spaces = spaces + 1;
    }
    let mark = j < end ? text.charAt(j) : "";
    if (mark != "`" && mark != "~") {
      i = end + 1;
      continue;
    }
    let n = runLength(text, j, mark);
    if (n < 3) {
      i = end + 1;
      continue;
    }
    if (end >= text.length) {
      return out;
    }
    let info = text.slice(j + n, end);
    let bodyAt = end + 1;
    let k = bodyAt;
    let close: int = -1;
    let closeEnd: int = -1;
    while (k < text.length) {
      let le = lineEnd(text, k);
      if (closesFence(text, k, le, mark, n)) {
        close = k;
        closeEnd = le;
        break;
      }
      k = le + 1;
    }
    if (close < 0) {
      return out;
    }
    if (mark == "`") {
      let hint = fenceHint(info);
      let found: FencedFile = {
        lang: hint.lang,
        path: hint.path,
        title: hint.title,
        body: text.slice(bodyAt, close),
        open: i,
        bodyAt: bodyAt,
        close: close,
        closeEnd: closeEnd,
      };
      out.push(found);
    }
    i = closeEnd + 1;
  }
  return out;
}

export type Extracted = {
  text: string,
  written: string[],
  notes: string[],
  nonce: string,
};

export type Neutralised = {
  text: string,
  changed: bool,
};

export function neutraliseMarkers(text: string, nonce: string): Neutralised {
  let out = "";
  let changed = false;
  let stamp = "[artifact:" + nonce + ":";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch != "[") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    if (text.slice(i, i + 10) != "[artifact:") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let end = lineEnd(text, i);
    let j = i;
    while (j < end && text.charAt(j) != "]") {
      j = j + 1;
    }
    if (text.slice(i, i + stamp.length) == stamp) {
      let stop = j < end ? j + 1 : end;
      out = out + text.slice(i, stop);
      i = stop;
      continue;
    }
    out = out + CLAIMED_SAVE;
    changed = true;
    i = j < end ? j + 1 : i + 10;
  }
  let done: Neutralised = { text: out, changed: changed };
  return done;
}

export type WireRef = {
  slot: int,
  version: int,
  path: string,
};

export type WireView = {
  text: string,
  refs: WireRef[],
};

function digitsEnd(text: string, at: int): int {
  let i = at;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) {
      break;
    }
    i = i + 1;
  }
  return i;
}

export function wireView(text: string): WireView {
  let out = "";
  let refs: WireRef[] = [];
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (ch != "[" || text.slice(i, i + 10) != "[artifact:") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let j = i + 10;
    while (j < text.length) {
      let c = text.charAt(j);
      if (c == ":" || c == "]" || c == "\n") {
        break;
      }
      j = j + 1;
    }
    if (j <= i + 10 || j >= text.length || text.charAt(j) != ":") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let slotAt = j + 1;
    let slotEnd = digitsEnd(text, slotAt);
    if (slotEnd == slotAt || text.slice(slotEnd, slotEnd + 2) != "@v") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let versionAt = slotEnd + 2;
    let versionEnd = digitsEnd(text, versionAt);
    if (versionEnd == versionAt || versionEnd >= text.length || text.charAt(versionEnd) != "]") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let k = versionEnd + 1;
    while (k < text.length && text.charAt(k) == " ") {
      k = k + 1;
    }
    let ps = k;
    while (k < text.length) {
      let c = text.charAt(k);
      if (infoBlank(c) || c == "\n") {
        break;
      }
      k = k + 1;
    }
    let path = text.slice(ps, k);
    if (path == "") {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let slot = parseInt(text.slice(slotAt, slotEnd)) ?? -1;
    let version = parseInt(text.slice(versionAt, versionEnd)) ?? 0;
    out = out + "[saved " + path + " v" + `${version}` + "]";
    let ref: WireRef = { slot: slot, version: version, path: path };
    refs.push(ref);
    i = k;
  }
  let view: WireView = { text: out, refs: refs };
  return view;
}

function roundPaths(db: Db, threadId: string, baseSeq: int): string[] {
  let out: string[] = [];
  if (baseSeq < 0) {
    return out;
  }
  let sql = "SELECT artifacts.path FROM artifact_versions"
    + " JOIN artifacts ON artifacts.id = artifact_versions.artifact_id"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND artifact_versions.turn_seq = " + placeholderAt(db, 2)
    + " AND artifact_versions.turn_seq >= 0";
  if (!db.query(sql, [threadId, `${baseSeq}`])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    out.push(db.value(i, 0).toLowerCase());
    i = i + 1;
  }
  return out;
}

function contains(list: string[], item: string): bool {
  let i: int = 0;
  while (i < list.length) {
    if (list[i] == item) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function laterFenceHas(paths: string[], k: int): bool {
  let lower = paths[k].toLowerCase();
  let m = k + 1;
  while (m < paths.length) {
    if (paths[m] != "" && paths[m].toLowerCase() == lower) {
      return true;
    }
    m = m + 1;
  }
  return false;
}

function existingIndex(haveLower: string[], path: string): int {
  let lower = path.toLowerCase();
  let i: int = 0;
  while (i < haveLower.length) {
    if (haveLower[i] == lower) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

export function extractFiles(db: Db, threadId: string, baseSeq: int, text: string, now: string): Extracted {
  let written: string[] = [];
  let notes: string[] = [];
  let nonce = crypto.randomUUID();

  if (baseSeq < 0) {
    notes.push("no files were extracted: this reply has no stored round to attach them to");
    let bare = neutraliseMarkers(text, nonce);
    if (bare.changed) {
      notes.push("text resembling a saved-file reference was not one; rewritten to say so");
    }
    let bail: Extracted = { text: bare.text, written: written, notes: notes, nonce: nonce };
    return bail;
  }

  let fences = fencedFiles(text);

  let have: ArtifactRow[] = listArtifacts(db, threadId);
  let haveLower: string[] = [];
  let h: int = 0;
  while (h < have.length) {
    haveLower.push(have[h].path.toLowerCase());
    h = h + 1;
  }
  let round = roundPaths(db, threadId, baseSeq);

  let paths: string[] = [];
  let f: int = 0;
  while (f < fences.length) {
    let raw = fences[f].path;
    if (raw == "") {
      paths.push("");
      f = f + 1;
      continue;
    }
    let p = normalScope(raw);
    let snap = existingIndex(haveLower, p);
    if (snap >= 0) {
      p = have[snap].path;
    }
    paths.push(p);
    f = f + 1;
  }

  let act: int[] = [];
  let accepted: int = 0;
  let bytesTotal: int = 0;
  let k: int = 0;
  while (k < fences.length) {
    let fence = fences[k];
    let path = paths[k];
    let take: int = 0;
    let bytes = utf8Length(fence.body);
    let existing = path == "" ? -1 : existingIndex(haveLower, path);
    let kind = path == "" ? "" : kindOf(path);
    if (path == "") {
    } else if (laterFenceHas(paths, k)) {
    } else if (contains(round, path.toLowerCase())) {
      notes.push("left the fence for " + path + " as written: this round already saved that path");
    } else if (existing >= 0) {
      let current = getVersion(db, have[existing].id, have[existing].currentVersion);
      if (current.id != "" && current.body == fence.body) {
        notes.push("did not save " + path + ": unchanged from version " + `${have[existing].currentVersion}`);
      } else {
        notes.push("did not save " + path + ": update " + path + " needs write_artifact");
      }
    } else if (kind == "javascript" || kind == "css") {
      notes.push("did not save " + path + ": a " + kind + " file needs write_artifact — a fence only creates inert files");
    } else if (kind == "code") {
      notes.push("did not save " + path + ": a fenced file may only create html, svg, markdown, json or text — save it with write_artifact");
    } else if (bytes > ARTIFACT_MAX) {
      notes.push("did not save " + path + ": an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
    } else if (accepted >= REPLY_FENCES_MAX) {
      notes.push("did not save " + path + ": at most " + `${REPLY_FENCES_MAX}` + " fenced files are saved per reply");
    } else if (bytesTotal + bytes > REPLY_EXTRACT_MAX) {
      notes.push("did not save " + path + ": a reply's fences save at most " + `${REPLY_EXTRACT_MAX}` + " bytes in total");
    } else {
      accepted = accepted + 1;
      bytesTotal = bytesTotal + bytes;
      take = 1;
    }
    act.push(take);
    k = k + 1;
  }

  let out = "";
  let cursor: int = 0;
  let w: int = 0;
  while (w < fences.length) {
    if (act[w] == 1) {
      let fence = fences[w];
      let path = paths[w];
      let saved = putArtifact(db, {
        threadId: threadId,
        path: path,
        title: fence.title,
        content: fence.body,
        note: "written in reply",
        origin: "generated",
        mustCreate: true,
        turnSeq: baseSeq,
        now: now,
      });
      if (!saved.ok) {
        notes.push("did not save " + path + ": " + saved.fault);
      } else {
        out = out + text.slice(cursor, fence.open)
          + "[artifact:" + nonce + ":" + `${saved.slot}` + "@v" + `${saved.version}` + "] " + path;
        cursor = fence.closeEnd;
        written.push(path);
      }
    }
    w = w + 1;
  }
  out = out + text.slice(cursor, text.length);

  let neutral = neutraliseMarkers(out, nonce);
  if (neutral.changed) {
    notes.push("text resembling a saved-file reference was not one; rewritten to say so");
  }
  let done: Extracted = { text: neutral.text, written: written, notes: notes, nonce: nonce };
  return done;
}

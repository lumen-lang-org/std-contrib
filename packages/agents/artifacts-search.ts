import { Db } from "../plume/driver.ts";
import { countWhere, placeholderAt } from "../plume/plume.ts";
import { artifactsMapping } from "./artifacts.ts";
import { likeLiteral } from "./knowledge.ts";

export const SEARCH_HITS_MAX: int = 20;
export const SEARCH_ARTIFACT_HITS_MAX: int = 5;
export const SEARCH_QUERY_MIN: int = 2;
export const SEARCH_QUERY_MAX: int = 200;

export type ArtifactHit = {
  path: string,
  slot: int,
  version: int,
  line: int,
  text: string,
  cut: bool,
};

export const SEARCH_SNIPPET_MAX: int = 160;

export const SEARCH_CUT_MARK: string = " [cut]";

export type EditHit = {
  at: int,
  line: int,
};

function editMatchAt(body: string, at: int, needle: string): bool {
  let i: int = 0;
  while (i < needle.length) {
    if (body.charCodeAt(at + i) != needle.charCodeAt(i)) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function editHits(body: string, needle: string, most: int): EditHit[] {
  let out: EditHit[] = [];
  if (needle.length == 0) {
    return out;
  }
  if (needle.length > body.length) {
    return out;
  }
  let line: int = 1;
  let i: int = 0;
  let last = body.length - needle.length;
  while (i <= last) {
    if (editMatchAt(body, i, needle)) {
      let hit: EditHit = { at: i, line: line };
      out.push(hit);
      if (out.length > most) {
        return out;
      }
    }
    if (body.charAt(i) == "\n") {
      line = line + 1;
    }
    i = i + 1;
  }
  return out;
}

export type ArtifactSearch = {
  ok: bool,
  hits: ArtifactHit[],
  searched: int,
  capped: bool,
  problem: string,
};

function searchRefusal(why: string): ArtifactSearch {
  let none: ArtifactHit[] = [];
  let out: ArtifactSearch = { ok: false, hits: none, searched: 0, capped: false, problem: why };
  return out;
}

function searchQueryProblem(query: string): string {
  if (query.length < SEARCH_QUERY_MIN || query.length > SEARCH_QUERY_MAX) {
    return "a search query is " + `${SEARCH_QUERY_MIN}` + " to " + `${SEARCH_QUERY_MAX}`
      + " bytes of UTF-8; this one is " + `${query.length}`;
  }
  let i: int = 0;
  while (i < query.length) {
    let c = query.charCodeAt(i);
    if (c < 32 || c == 127) {
      return "a search query is one line of plain text — no newlines or control characters";
    }
    i = i + 1;
  }
  return "";
}

function searchLineStop(body: string, from: int): int {
  let i = from;
  while (i < body.length && body.charAt(i) != "\n") {
    i = i + 1;
  }
  if (i > from && body.charAt(i - 1) == "\r") {
    return i - 1;
  }
  return i;
}

function searchLineHas(line: string, query: string): bool {
  if (query.length > line.length) {
    return false;
  }
  let last = line.length - query.length;
  let i: int = 0;
  while (i <= last) {
    if (editMatchAt(line, i, query)) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function searchArtifacts(db: Db, threadId: string, query: string): ArtifactSearch {
  let bad = searchQueryProblem(query);
  if (bad != "") {
    return searchRefusal(bad);
  }

  let searched = countWhere(db, artifactsMapping(), "thread_id = " + placeholderAt(db, 1), [threadId]);
  if (searched < 0) {
    return searchRefusal("could not count this thread's artifacts");
  }

  let pattern = "%" + likeLiteral(query) + "%";
  let sql = "SELECT artifacts.path, artifacts.slot, artifacts.title, artifacts.current_version, artifact_versions.body"
    + " FROM artifacts"
    + " JOIN artifact_versions ON artifact_versions.artifact_id = artifacts.id"
    + " AND artifact_versions.version = artifacts.current_version"
    + " WHERE artifacts.thread_id = " + placeholderAt(db, 1)
    + " AND (artifacts.path LIKE " + placeholderAt(db, 2) + " ESCAPE '!'"
    + " OR artifacts.title LIKE " + placeholderAt(db, 3) + " ESCAPE '!'"
    + " OR artifact_versions.body LIKE " + placeholderAt(db, 4) + " ESCAPE '!')"
    + " ORDER BY artifacts.slot";
  if (!db.query(sql, [threadId, pattern, pattern, pattern])) {
    return searchRefusal("could not search this thread's artifacts");
  }

  let paths: string[] = [];
  let slots: int[] = [];
  let titles: string[] = [];
  let versions: int[] = [];
  let bodies: string[] = [];
  let r: int = 0;
  while (r < db.rows()) {
    paths.push(db.value(r, 0));
    slots.push(parseInt(db.value(r, 1)) ?? -1);
    titles.push(db.value(r, 2));
    versions.push(parseInt(db.value(r, 3)) ?? 0);
    bodies.push(db.value(r, 4));
    r = r + 1;
  }

  let hits: ArtifactHit[] = [];
  let capped = false;
  let a: int = 0;
  while (a < paths.length) {
    let mine: int = 0;

    if (searchLineHas(paths[a], query)) {
      let snip = searchSnippet(paths[a]);
      let hit: ArtifactHit = {
        path: paths[a],
        slot: slots[a],
        version: versions[a],
        line: 0,
        text: snip.text,
        cut: snip.cut,
      };
      if (hits.length >= SEARCH_HITS_MAX) {
        capped = true;
      } else {
        hits.push(hit);
        mine = mine + 1;
      }
    }
    if (titles[a] != "" && searchLineHas(titles[a], query)) {
      let snip = searchSnippet(titles[a]);
      let hit: ArtifactHit = {
        path: paths[a],
        slot: slots[a],
        version: versions[a],
        line: 0,
        text: snip.text,
        cut: snip.cut,
      };
      if (mine >= SEARCH_ARTIFACT_HITS_MAX || hits.length >= SEARCH_HITS_MAX) {
        capped = true;
      } else {
        hits.push(hit);
        mine = mine + 1;
      }
    }

    let body = bodies[a];
    let i: int = 0;
    let line: int = 1;
    while (i <= body.length) {
      let stop = searchLineStop(body, i);
      let text = body.slice(i, stop);
      if (searchLineHas(text, query)) {
        if (mine >= SEARCH_ARTIFACT_HITS_MAX || hits.length >= SEARCH_HITS_MAX) {
          capped = true;
          break;
        }
        let snip = searchSnippet(text);
        let hit: ArtifactHit = {
          path: paths[a],
          slot: slots[a],
          version: versions[a],
          line: line,
          text: snip.text,
          cut: snip.cut,
        };
        hits.push(hit);
        mine = mine + 1;
      }
      while (stop < body.length && body.charAt(stop) != "\n") {
        stop = stop + 1;
      }
      i = stop + 1;
      line = line + 1;
    }
    a = a + 1;
  }

  let out: ArtifactSearch = {
    ok: true,
    hits: hits,
    searched: searched,
    capped: capped,
    problem: "",
  };
  return out;
}

function editLooseBlank(c: int): bool {
  return c == 32 || c == 9 || c == 13;
}

function editLooseAt(body: string, at: int, needle: string): bool {
  let bi = at;
  let ni: int = 0;
  while (ni < needle.length) {
    if (editLooseBlank(needle.charCodeAt(ni))) {
      ni = ni + 1;
      continue;
    }
    while (bi < body.length && editLooseBlank(body.charCodeAt(bi))) {
      bi = bi + 1;
    }
    if (bi >= body.length) {
      return false;
    }
    if (body.charCodeAt(bi) != needle.charCodeAt(ni)) {
      return false;
    }
    bi = bi + 1;
    ni = ni + 1;
  }
  return true;
}

export function editLoose(body: string, needle: string): int {
  let ns: int = 0;
  while (ns < needle.length && editLooseBlank(needle.charCodeAt(ns))) {
    ns = ns + 1;
  }
  if (ns >= needle.length) {
    return -1;
  }
  let first = needle.charCodeAt(ns);
  let line: int = 1;
  let i: int = 0;
  while (i < body.length) {
    if (body.charCodeAt(i) == first) {
      if (editLooseAt(body, i, needle.slice(ns, needle.length))) {
        return line;
      }
    }
    if (body.charAt(i) == "\n") {
      line = line + 1;
    }
    i = i + 1;
  }
  return -1;
}

export function editLineAt(body: string, at: int): int {
  let line: int = 1;
  let i: int = 0;
  while (i < at && i < body.length) {
    if (body.charAt(i) == "\n") {
      line = line + 1;
    }
    i = i + 1;
  }
  return line;
}

function searchContinuationByte(b: int): bool {
  return b >= 128 && b < 192;
}

export function searchSnippet(lineText: string): ArtifactHit {
  let text = lineText;
  let cut = false;
  if (lineText.length > SEARCH_SNIPPET_MAX) {
    let end = SEARCH_SNIPPET_MAX;
    while (end > 0 && searchContinuationByte(lineText.charCodeAt(end))) {
      end = end - 1;
    }
    text = lineText.slice(0, end) + SEARCH_CUT_MARK;
    cut = true;
  }
  let out: ArtifactHit = { path: "", slot: -1, version: 0, line: 0, text: text, cut: cut };
  return out;
}

function editLineStart(body: string, at: int, up: int): int {
  let start = at;
  while (start > 0 && body.charAt(start - 1) != "\n") {
    start = start - 1;
  }
  let back: int = 0;
  while (back < up && start > 0) {
    start = start - 1;
    while (start > 0 && body.charAt(start - 1) != "\n") {
      start = start - 1;
    }
    back = back + 1;
  }
  return start;
}

export function editContext(body: string, from: int, to: int): string {
  let f = from;
  if (f < 0) {
    f = 0;
  }
  if (f > body.length) {
    f = body.length;
  }
  let t = to;
  if (t < f) {
    t = f;
  }
  if (t > body.length) {
    t = body.length;
  }
  let start = editLineStart(body, f, 2);
  let anchor = t;
  if (t > f && body.charAt(t - 1) == "\n") {
    anchor = t - 1;
  }
  let end = anchor;
  while (end < body.length && body.charAt(end) != "\n") {
    end = end + 1;
  }
  let ahead: int = 0;
  while (ahead < 2 && end < body.length) {
    if (end + 1 >= body.length) {
      break;
    }
    end = end + 1;
    while (end < body.length && body.charAt(end) != "\n") {
      end = end + 1;
    }
    ahead = ahead + 1;
  }
  return body.slice(start, end);
}

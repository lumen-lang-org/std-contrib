import { Db } from "../plume/driver.ts";
import { executeWith, placeholderAt, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { ARTIFACT_MAX, ARTIFACT_NOTE_MAX, THREAD_BYTES_MAX, getArtifact, getVersion, labelFault, nextVersion, threadBytes, utf8Length } from "./artifacts.ts";
import { ArtifactHit, editHits, editLineAt, editLoose, editContext, searchSnippet } from "./artifacts-search.ts";
import { normalScope } from "./knowledge.ts";

export const EDIT_HITS_MOST: int = 8;

const EDIT_ATTEMPTS: int = 4;

export type ArtifactEdit = {
  threadId: string,
  path: string,
  oldText: string,
  newText: string,
  note: string,
  turnSeq: int,
  now: string,
};

export type ArtifactEdited = {
  ok: bool,
  slot: int,
  version: int,
  line: int,
  bytes: int,
  context: string,
  hits: ArtifactHit[],
  fault: string,
};

function editRefusal(why: string): ArtifactEdited {
  let none: ArtifactHit[] = [];
  let out: ArtifactEdited = {
    ok: false, slot: -1, version: 0, line: 0, bytes: 0,
    context: "", hits: none, fault: why,
  };
  return out;
}

function editAmbiguous(path: string, version: int, found: ArtifactHit[], tooMany: bool): ArtifactEdited {
  let count = tooMany ? "more than " + `${EDIT_HITS_MOST}` + " times" : `${found.length}` + " times";
  let why = "old matches " + count + " in " + path + " (version " + `${version}` + "); "
    + "include more surrounding text until it matches exactly once:";
  let i: int = 0;
  while (i < found.length) {
    why = why + "\n  " + `${i + 1}` + ". line " + `${found[i].line}` + ": " + found[i].text;
    i = i + 1;
  }
  let out: ArtifactEdited = {
    ok: false, slot: -1, version: 0, line: 0, bytes: 0,
    context: "", hits: found, fault: why,
  };
  return out;
}

export function editArtifact(db: Db, edit: ArtifactEdit): ArtifactEdited {
  if (edit.threadId == "") {
    return editRefusal("an artifact belongs to a thread");
  }
  if (edit.oldText == "") {
    return editRefusal("old is empty, and empty text would match everywhere; send the exact text to replace, verbatim from the current version");
  }
  if (edit.oldText == edit.newText) {
    return editRefusal("old and new are identical; nothing would change, and a version that changes nothing is not saved");
  }
  let badNote = labelFault("note", edit.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") {
    return editRefusal(badNote);
  }
  return editAttempt(db, edit, 1);
}

function editAttempt(db: Db, edit: ArtifactEdit, attempt: int): ArtifactEdited {
  let path = normalScope(edit.path);

  let opened = beginTransaction(db);
  if (!opened.ok) {
    return editRefusal("the edit could not be saved; try again");
  }

  let artifact = getArtifact(db, edit.threadId, path);
  if (artifact.id == "") {
    rollbackTransaction(db);
    return editRefusal("There is no artifact at " + path + " in this conversation.");
  }

  let n = artifact.currentVersion;
  if (attempt > 1) {
    let past = nextVersion(db, artifact.id);
    if (past < 2) {
      rollbackTransaction(db);
      return editRefusal("could not read the version history of " + path);
    }
    n = past - 1;
  }
  let current = getVersion(db, artifact.id, n);
  if (current.id == "") {
    rollbackTransaction(db);
    return editRefusal("Artifact " + path + " points at version " + `${n}`
      + ", which is not in its history.");
  }
  let body = current.body;

  let found = editHits(body, edit.oldText, EDIT_HITS_MOST);
  if (found.length == 0) {
    rollbackTransaction(db);
    let why = "old matches nothing in " + path + " (version " + `${n}` + ").";
    if (attempt > 1) {
      why = "The artifact changed while you were editing: " + why
        + " Read or search it again before retrying.";
      return editRefusal(why);
    }
    let doubled = edit.oldText.indexOf("\\") >= 0 ? body.indexOf(edit.oldText.replaceAll("\\", "\\\\")) : -1;
    let halved = edit.oldText.indexOf("\\\\") >= 0 ? body.indexOf(edit.oldText.replaceAll("\\\\", "\\")) : -1;
    if (doubled >= 0 || halved >= 0) {
      let fix = doubled >= 0
        ? "the artifact holds MORE backslashes than your old — send each backslash as it appears in read_artifact's answer, without unescaping it"
        : "the artifact holds FEWER backslashes than your old — you have escaped it one time too many";
      why = why + " The text matches at line " + `${editLineAt(body, doubled >= 0 ? doubled : halved)}`
        + " except for backslash escaping: " + fix + ".";
      return editRefusal(why);
    }
    let near = editLoose(body, edit.oldText);
    if (near >= 0) {
      why = why + " A whitespace-insensitive scan matches at line " + `${near}`
        + " — read_artifact the file and copy the text exactly, whitespace, quotes and indentation included.";
    } else {
      why = why + " No near miss either: search_artifacts for the text, or read_artifact the file, and copy from what comes back.";
    }
    return editRefusal(why);
  }
  if (found.length > 1) {
    rollbackTransaction(db);
    let tooMany = found.length > EDIT_HITS_MOST;
    let listed: ArtifactHit[] = [];
    let shown = tooMany ? EDIT_HITS_MOST : found.length;
    let i: int = 0;
    while (i < shown) {
      let lineStart = editLineStartAt(body, found[i].at);
      let lineStop = editLineStopAt(body, found[i].at);
      let snip = searchSnippet(body.slice(lineStart, lineStop));
      let hit: ArtifactHit = {
        path: path, slot: artifact.slot, version: n,
        line: found[i].line, text: snip.text, cut: snip.cut,
      };
      listed.push(hit);
      i = i + 1;
    }
    let out = editAmbiguous(path, n, listed, tooMany);
    if (attempt > 1) {
      let raced: ArtifactEdited = {
        ok: false, slot: -1, version: 0, line: 0, bytes: 0, context: "",
        hits: out.hits,
        fault: "The artifact changed while you were editing, and " + out.fault
          + "\nRead or search it again before retrying.",
      };
      return raced;
    }
    return out;
  }

  let at = found[0].at;
  let spliced = body.slice(0, at) + edit.newText + body.slice(at + edit.oldText.length);

  let bytes = utf8Length(spliced);
  if (bytes > ARTIFACT_MAX) {
    rollbackTransaction(db);
    return editRefusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }
  let held = threadBytes(db, edit.threadId);
  if (held < 0) {
    rollbackTransaction(db);
    return editRefusal("could not read how much this thread's artifacts hold");
  }
  if (held + bytes > THREAD_BYTES_MAX) {
    rollbackTransaction(db);
    return editRefusal("a thread's artifacts hold at most " + `${THREAD_BYTES_MAX}` + " bytes across all versions; this edit would exceed that");
  }

  let line = editLineAt(spliced, at);
  let note = edit.note == "" ? "edit at line " + `${line}` : edit.note;

  let version = n + 1;
  let wrote = executeWith(db,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
    + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
    + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ", " + placeholderAt(db, 9) + ")",
    [artifact.id + ":" + `${version}`, artifact.id, `${version}`, spliced, `${bytes}`,
     "generated", `${edit.turnSeq}`, note, edit.now]);
  if (!wrote.ok) {
    rollbackTransaction(db);
    if (attempt < EDIT_ATTEMPTS) {
      return editAttempt(db, edit, attempt + 1);
    }
    return editRefusal("this artifact is being written to too quickly; try again");
  }

  let moved = executeWith(db,
    "UPDATE artifacts SET current_version = " + placeholderAt(db, 1)
    + ", updated_at = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3),
    [`${version}`, edit.now, artifact.id]);
  if (!moved.ok) {
    rollbackTransaction(db);
    return editRefusal("the edit could not be saved; try again");
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    if (attempt < EDIT_ATTEMPTS) {
      return editAttempt(db, edit, attempt + 1);
    }
    return editRefusal("the edit could not be saved; try again");
  }

  let none: ArtifactHit[] = [];
  let out: ArtifactEdited = {
    ok: true, slot: artifact.slot, version: version, line: line, bytes: bytes,
    context: editContext(spliced, at, at + edit.newText.length),
    hits: none, fault: "",
  };
  return out;
}

function editLineStartAt(body: string, at: int): int {
  let i = at;
  while (i > 0 && body.charAt(i - 1) != "\n") {
    i = i - 1;
  }
  return i;
}

function editLineStopAt(body: string, at: int): int {
  let i = at;
  while (i < body.length && body.charAt(i) != "\n") {
    i = i + 1;
  }
  if (i > 0 && body.charAt(i - 1) == "\r") {
    return i - 1;
  }
  return i;
}

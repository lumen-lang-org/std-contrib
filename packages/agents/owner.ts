import { Db } from "../plume/driver.ts";
import { executeWith, placeholderAt } from "../plume/plume.ts";
import { jsonText } from "./scan.ts";

export function trustsProxyAuth(): bool {
  let set = (process.env("AGENTS_TRUST_PROXY_AUTH") ?? "").trim().toLowerCase();
  return set == "1" || set == "true" || set == "yes" || set == "on";
}

export const UNKNOWN_TAG: string = " unreadable x-user";

export function tagsFromHeader(trusted: bool, xUser: string): string[] {
  let none: string[] = [];
  if (!trusted) {
    return none;
  }
  let text = xUser.trim();
  if (text.startsWith("{")) {
    let uuid = jsonText(text, "uuid");
    if (uuid == "") {
      return [UNKNOWN_TAG];
    }
    return [uuid];
  }
  return [text];
}

export function identityUnreadable(trusted: bool, xUser: string): bool {
  let tags = tagsFromHeader(trusted, xUser);
  return tags.length == 1 && tags[0] == UNKNOWN_TAG;
}

export function ownerClause(db: Db, tags: string[], from: int): string {
  if (tags.length == 0) {
    return "";
  }
  let out = "owner IN (";
  let i: int = 0;
  while (i < tags.length) {
    if (i > 0) {
      out = out + ", ";
    }
    out = out + placeholderAt(db, from + i);
    i = i + 1;
  }
  return out + ")";
}

export function owningTag(tags: string[]): string {
  if (tags.length == 0) {
    return "";
  }
  return tags[0];
}

export function holdsOwner(tags: string[], owner: string): bool {
  if (tags.length == 0) {
    return true;
  }
  let i: int = 0;
  while (i < tags.length) {
    if (tags[i] == owner) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function documentIsOwned(document: string, tags: string[]): bool {
  return holdsOwner(tags, jsonText(document, "owner"));
}

/** The same document, filed under an owner.
 *
 *  The DTO a route validates is the client's shape and deliberately has no
 *  owner in it: who is asking is not something a caller gets to say. This
 *  splices it in on the way to the table, so the column is set from the
 *  request and never from the body. */
export function ownedDocument(document: string, owner: string): string {
  let text = document.trim();
  if (!text.startsWith("{")) {
    return document;
  }
  let rest = text.slice(1);
  if (rest.trim().startsWith("}")) {
    return "{\"owner\":" + JSON.stringify(owner) + rest;
  }
  return "{\"owner\":" + JSON.stringify(owner) + "," + rest;
}

/** Ownership of a row whose table predates it.
 *
 *  `agents`, `prompts` and `skills` are written from record literals in dozens
 *  of places, and a NOT NULL column added to them turns every one of those into
 *  a failed insert. This keeps the fact beside the row instead: absent means
 *  the deployment's, which is exactly what everything written before today is.
 *
 *  A kind is spelled into the clause and never bound, so it is a constant here
 *  and never a caller's string. */
export const OWNED_AGENT: string = "agent";
export const OWNED_PROMPT: string = "prompt";
export const OWNED_SKILL: string = "skill";

/** Rows that are the deployment's, plus the ones this owner holds. `at` is the
 *  first placeholder this clause may use; it takes exactly one. */
export function ownedRowsClause(db: Db, kind: string, at: int): string {
  let held = "SELECT row_id FROM row_owners WHERE kind = '" + kind + "'";
  return "(id NOT IN (" + held + ")"
    + " OR id IN (" + held + " AND owner = " + placeholderAt(db, at) + "))";
}

/** Only the rows this owner wrote — not the deployment's, which everybody
 *  may use but nobody but an operator may change. `ownedRowsClause` answers
 *  what you may USE; this answers what is YOURS. */
export function myRowsClause(db: Db, kind: string, at: int): string {
  return "id IN (SELECT row_id FROM row_owners WHERE kind = '" + kind + "'"
    + " AND owner = " + placeholderAt(db, at) + ")";
}

export function ownerOfRow(db: Db, kind: string, id: string): string {
  let sql = "SELECT owner FROM row_owners WHERE kind = '" + kind + "'"
    + " AND row_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [id])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  return db.value(0, 0);
}

/** Files a row under an owner. The deployment's rows are the absence of a row
 *  here, so filing as the deployment removes rather than writes. */
export function ownRow(db: Db, kind: string, id: string, owner: string): bool {
  let cleared = executeWith(db, "DELETE FROM row_owners WHERE kind = '" + kind + "'"
    + " AND row_id = " + placeholderAt(db, 1), [id]);
  if (!cleared.ok) {
    return false;
  }
  if (owner == "") {
    return true;
  }
  let written = executeWith(db, "INSERT INTO row_owners (kind, row_id, owner) VALUES ('"
    + kind + "', " + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")",
    [id, owner]);
  return written.ok;
}

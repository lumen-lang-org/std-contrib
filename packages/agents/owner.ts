import { Db } from "../plume/driver.ts";
import { placeholderAt } from "../plume/plume.ts";
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

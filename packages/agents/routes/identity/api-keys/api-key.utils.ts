export const MAX_KEYS_PER_OWNER: int = 20;
export const MAX_KEY_NAME: int = 60;

export const JOULE_SCOPES: string[] = ["search", "retrieve", "suggest"];

export type ApiKeyRow = {
  id: string,
  owner: string,
  name: string,
  keyPrefix: string,
  keyHash: string,
  scopes: string,
  createdAt: string,
  lastUsedAt: string,
};

export function emptyApiKey(): ApiKeyRow {
  let none: ApiKeyRow = {
    id: "", owner: "", name: "", keyPrefix: "", keyHash: "", scopes: "",
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

export type ApiKeyView = {
  id: string,
  name: string,
  keyPrefix: string,
  scopes: string,
  createdAt: string,
  lastUsedAt: string,
};

export function viewOf(row: ApiKeyRow): ApiKeyView {
  let v: ApiKeyView = {
    id: row.id, name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  };
  return v;
}

function isJouleScope(s: string): bool {
  let i: int = 0;
  while (i < JOULE_SCOPES.length) {
    if (JOULE_SCOPES[i] == s) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function cleanScopes(raw: string): string {
  let parts = raw.split(",");
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim().toLowerCase();
    if (t == "*") {
      return "*";
    }
    if (t != "" && isJouleScope(t)) {
      out = out == "" ? t : out + "," + t;
    }
    i = i + 1;
  }
  return out;
}

export function scopeList(scopes: string): string[] {
  if (scopes.trim() == "*") {
    let all: string[] = ["*"];
    return all;
  }
  let parts = scopes.split(",");
  let out: string[] = [];
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim();
    if (t != "") {
      out.push(t);
    }
    i = i + 1;
  }
  return out;
}

export function hasScope(granted: string[], required: string): bool {
  let i: int = 0;
  while (i < granted.length) {
    if (granted[i] == "*") {
      return true;
    }
    if (granted[i] == required) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function looksLikeKey(secret: string): bool {
  if (secret.length < 12) {
    return false;
  }
  if (secret.slice(0, 3) != "jl_") {
    return false;
  }
  return secret.indexOf("_", 3) > 3;
}

export type ApiKeyMade = {
  id: string,
  secret: string,
  prefix: string,
  fault: string,
};

export type ApiKeyAuth = {
  ok: bool,
  owner: string,
  keyId: string,
  scopes: string[],
};

import { Db } from "../plume/driver.ts";
import { connectDatabase, persist, findById, listWhere, deleteById, existsById } from "../plume/plume.ts";
import { CredentialRow, credentialsMapping } from "./schema.ts";

export function masterKey(): string {
  return process.env("LUMEN_MASTER_KEY") ?? "";
}

export function masterKeyFault(key: string): string {
  if (key == "") {
    return "LUMEN_MASTER_KEY is not set — generate one with crypto.randomKey()";
  }
  if (key.length != 32) {
    return "LUMEN_MASTER_KEY is " + `${key.length}` + " bytes; AES-256 needs exactly 32";
  }
  return "";
}

function credentialId(provider: string): string {
  return "cred-" + provider;
}

export type CredentialWrite = {
  provider: string,
  apiKey: string,
  masterKey: string,
  now: string,
};

export function storeCredential(db: Db, write: CredentialWrite): string {
  let provider = write.provider;
  let apiKey = write.apiKey;
  let key = write.masterKey;
  let now = write.now;
  let fault = masterKeyFault(key);
  if (fault != "") {
    return fault;
  }
  if (apiKey == "") {
    return "an empty key is not a credential";
  }

  if (existsById(db, credentialsMapping(), credentialId(provider))) {
    deleteById(db, credentialsMapping(), credentialId(provider));
  }
  let row: CredentialRow = {
    id: credentialId(provider),
    provider: provider,
    envelope: crypto.encrypt(apiKey, key),
    updatedAt: now,
  };
  let written = persist(db, credentialsMapping(), JSON.stringify(row));
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function credentialFor(db: Db, provider: string, key: string): string {
  if (masterKeyFault(key) != "") {
    return "";
  }
  let document = findById(db, credentialsMapping(), credentialId(provider));
  if (document == "") {
    return "";
  }
  let row: CredentialRow = JSON.parse<CredentialRow>(document);
  return crypto.decrypt(row.envelope, key);
}

export function hasCredential(db: Db, provider: string): bool {
  return existsById(db, credentialsMapping(), credentialId(provider));
}

export function forgetCredential(db: Db, provider: string): bool {
  if (!existsById(db, credentialsMapping(), credentialId(provider))) {
    return false;
  }
  return deleteById(db, credentialsMapping(), credentialId(provider)).ok;
}

export function destinationOf(url: string): string {
  let text = url.trim();
  let mark = text.indexOf("://");
  if (mark < 0) {
    return "";
  }
  let scheme = text.slice(0, mark).toLowerCase();
  if (scheme != "http" && scheme != "https") {
    return "";
  }
  let rest = text.slice(mark + 3, text.length);
  let cut = rest.length;
  let slash = rest.indexOf("/");
  if (slash >= 0 && slash < cut) {
    cut = slash;
  }
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) {
    cut = question;
  }
  let fragment = rest.indexOf("#");
  if (fragment >= 0 && fragment < cut) {
    cut = fragment;
  }
  let authority = rest.slice(0, cut).toLowerCase();
  let at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1, authority.length);
  }
  if (authority == "") {
    return "";
  }
  return scheme + "://" + authority;
}

export type DestinationMove = {
  subject: string,
  secretName: string,
  clearWith: string,
  was: string,
  now: string,
  secretStored: bool,
};

function namedDestination(origin: string): string {
  if (origin == "") {
    return "an address this cannot read";
  }
  return origin;
}

export function destinationFault(move: DestinationMove): string {
  if (!move.secretStored) {
    return "";
  }
  let from = destinationOf(move.was);
  let to = destinationOf(move.now);
  if (from != "" && from == to) {
    return "";
  }
  return move.subject + " sends to " + namedDestination(from) + ", and "
    + move.secretName + " was stored for that address; pointing it at "
    + namedDestination(to) + " would send the secret there too. Clear the secret first with "
    + move.clearWith + ", then set it again once the address is right.";
}

export function providersWithCredentials(db: Db): string[] {
  let out: string[] = [];
  let none: string[] = [];
  let json = listWhere(db, credentialsMapping(), "", none);
  let rest = json;
  while (true) {
    let at = rest.indexOf("\"provider\"");
    if (at < 0) {
      return out;
    }
    rest = rest.substring(at + 10, rest.length);
    let open = rest.indexOf("\"");
    if (open < 0) {
      return out;
    }
    rest = rest.substring(open + 1, rest.length);
    let close = rest.indexOf("\"");
    if (close < 0) {
      return out;
    }
    out.push(rest.substring(0, close));
    rest = rest.substring(close + 1, rest.length);
  }
  return out;
}

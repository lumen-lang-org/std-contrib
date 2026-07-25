// Provider API keys, encrypted at rest.
//
//   let key = masterKey();                       // from the environment
//   storeCredential(db, "mistral", "sk-...", key);
//   let secret = credentialFor(db, "mistral", key);
//
// The ciphertext is a row and the master key is not. Encrypting a credential
// with a key stored beside it protects nothing, so the master key comes from
// the environment and the database never sees it — which also means losing the
// environment loses the credentials, and that is the intended trade.

import { Db } from "../plume/driver.ts";
import { connectDatabase, persist, findById, listWhere, deleteById, existsById } from "../plume/plume.ts";
import { CredentialRow, credentialsMapping } from "./schema.ts";

// The master key, or an empty string. A caller that gets "" must refuse to
// start rather than fall back to storing plaintext — there is no safe default
// here, so there is no default.
export function masterKey(): string {
  return process.env("LUMEN_MASTER_KEY") ?? "";
}

// Why a master key is unusable, or "" if it is fine.
export function masterKeyProblem(key: string): string {
  if (key == "") {
    return "LUMEN_MASTER_KEY is not set — generate one with crypto.randomKey()";
  }
  if (key.length != 32) {
    return "LUMEN_MASTER_KEY is " + `${key.length}` + " bytes; AES-256 needs exactly 32";
  }
  return "";
}

// A credential's row id is its provider, so one provider has one key and
// storing a second replaces the first rather than leaving both.
function credentialId(provider: string): string {
  return "cred-" + provider;
}

export function storeCredential(db: Db, provider: string, apiKey: string, key: string, now: string): string {
  let problem = masterKeyProblem(key);
  if (problem != "") { return problem; }
  // An empty plaintext encrypts to a valid envelope that decrypts to "", which
  // is indistinguishable from a failure to open it. Refusing here keeps that
  // ambiguity out of the table.
  if (apiKey == "") { return "an empty key is not a credential"; }

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
  if (!written.ok) { return written.error; }
  return "";
}

// The key for a provider, or "" if there is none, the master key is wrong, or
// the row has been altered. All three are the same answer on purpose: a caller
// that could tell them apart could use this to test master keys.
export function credentialFor(db: Db, provider: string, key: string): string {
  if (masterKeyProblem(key) != "") { return ""; }
  let document = findById(db, credentialsMapping(), credentialId(provider));
  if (document == "") { return ""; }
  let row: CredentialRow = JSON.parse<CredentialRow>(document);
  return crypto.decrypt(row.envelope, key);
}

// Which providers have a credential stored. Names only — nothing here returns
// an envelope, so a listing endpoint cannot leak one by accident.
export function providersWithCredentials(db: Db): string[] {
  let out: string[] = [];
  let none: string[] = [];
  let json = listWhere(db, credentialsMapping(), "", none);
  let rest = json;
  while (true) {
    let at = rest.indexOf("\"provider\"");
    if (at < 0) { return out; }
    rest = rest.substring(at + 10, rest.length);
    let open = rest.indexOf("\"");
    if (open < 0) { return out; }
    rest = rest.substring(open + 1, rest.length);
    let close = rest.indexOf("\"");
    if (close < 0) { return out; }
    out.push(rest.substring(0, close));
    rest = rest.substring(close + 1, rest.length);
  }
  return out;
}

// Provider API keys, encrypted at rest.
//
//   let key = masterKey();                       // from the environment
//   storeCredential(db, { provider: "mistral", apiKey: "sk-...",
//                          masterKey: key, now: now });
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

// A credential to store.
//
// `apiKey` and `masterKey` were adjacent parameters named `apiKey` and `key`,
// both secrets, both opaque strings, differing by one word. Swapped, this
// encrypts the MASTER key under a value handed to a vendor: masterKeyProblem
// only checks length and hex, so a 32-hex-character provider token passes and
// the row is written. credentialFor then returns "" forever, which this file
// deliberately makes indistinguishable from a wrong master key — so the only
// symptom is an empty string, and your master key is in the table encrypted
// under something a third party issued.
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

// Whether a provider has a credential at all, without opening it. Asked by
// callers deciding whether a secret is at stake, which is a different question
// from what the secret is.
export function hasCredential(db: Db, provider: string): bool {
  return existsById(db, credentialsMapping(), credentialId(provider));
}

// Delete a credential. True when there was one to delete.
//
// Its own function because the row id is this file's business: five callers
// spelling "cred-" + provider is five places to get wrong, and one of them
// deleting the wrong row leaves a secret behind rather than reporting
// anything.
export function forgetCredential(db: Db, provider: string): bool {
  if (!existsById(db, credentialsMapping(), credentialId(provider))) { return false; }
  return deleteById(db, credentialsMapping(), credentialId(provider)).ok;
}

// --- where a secret is allowed to go -----------------------------------------
//
// A key here can be written and never read back, and that invariant is only
// worth as much as the address the key is sent to. Every secret in this
// package is used by a call whose destination is a column — a model's base
// URL, a server's endpoint, the collector's address — and a column is writable
// by anyone who can write a row. Repoint the column, press the button that
// uses the key, and the key arrives at an address of your choosing: written
// once, read back forever.
//
// So the address is authorised the same moment the secret is: writing a key is
// what says where it may go. Moving the address afterwards is refused while a
// secret is stored, and the refusal names the request that clears it. Clearing
// is destructive — whoever moves the address has to be able to supply the
// secret again — which is what makes this fail closed: an attacker with write
// access can destroy a credential, and cannot read one.

// The origin of a URL — scheme, host and port, lower-cased — or "" when there
// is none to read.
//
// The origin rather than the whole URL, because it is the origin that decides
// who receives the bytes. A path is ours to choose; a host is not.
export function destinationOf(url: string): string {
  let text = url.trim();
  let mark = text.indexOf("://");
  if (mark < 0) { return ""; }
  let scheme = text.slice(0, mark).toLowerCase();
  if (scheme != "http" && scheme != "https") { return ""; }
  let rest = text.slice(mark + 3, text.length);
  let cut = rest.length;
  let slash = rest.indexOf("/");
  if (slash >= 0 && slash < cut) { cut = slash; }
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) { cut = question; }
  let fragment = rest.indexOf("#");
  if (fragment >= 0 && fragment < cut) { cut = fragment; }
  let authority = rest.slice(0, cut).toLowerCase();
  // A user-info half is not part of where this goes, and leaving it in would
  // make two spellings of one host compare unequal — which here means an
  // ordinary edit reads as a move and a move reads as an ordinary edit.
  let at = authority.lastIndexOf("@");
  if (at >= 0) { authority = authority.slice(at + 1, authority.length); }
  if (authority == "") { return ""; }
  return scheme + "://" + authority;
}

// A stored secret about to be pointed somewhere else.
export type DestinationMove = {
  // What is moving, as a reader knows it: "model m1", "server s1".
  subject: string,
  // What the secret is called, and the request that clears it. The refusal is
  // a sentence someone has to act on, so it names the next thing to do.
  secretName: string,
  clearWith: string,
  // Where the secret goes today, and where this request would send it. Full
  // URLs; only their origins are compared.
  was: string,
  now: string,
  // Whether there is anything to protect. No secret, no refusal — this is a
  // rule about secrets, not about addresses.
  secretStored: bool,
};

// How an origin reads in a sentence when there is nothing to read.
function namedDestination(origin: string): string {
  if (origin == "") { return "an address this cannot read"; }
  return origin;
}

// Why a destination may not be changed, or "" when it may.
//
// Fails closed twice over: an address that cannot be parsed is treated as a
// different one, so a malformed URL refuses rather than passes, and a subject
// with no address on record refuses rather than assuming the new one is where
// the secret was always going.
export function destinationProblem(move: DestinationMove): string {
  if (!move.secretStored) { return ""; }
  let from = destinationOf(move.was);
  let to = destinationOf(move.now);
  if (from != "" && from == to) { return ""; }
  return move.subject + " sends to " + namedDestination(from) + ", and "
    + move.secretName + " was stored for that address; pointing it at "
    + namedDestination(to) + " would send the secret there too. Clear the secret first with "
    + move.clearWith + ", then set it again once the address is right.";
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

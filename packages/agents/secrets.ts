// Secrets a workflow step may send, without ever holding.
//
// An HTTP step that calls a real API needs a key, and the graph is the wrong
// place for one three times over: it is a JSON column rewritten on every
// drag, it is served to the browser and read aloud by show_workflow, and it
// is authored by a model. WfNode.botId already states the rule for Telegram —
// the credential belongs in the one table that encrypts it — so the node
// carries `secretId` and this module owns everything the id points at: the
// row, the value (through credentials.ts, ref "secret:<id>", write-only
// forever), which header the value fills, and which origin it may be sent to.
//
// The destination is pinned when the secret is stored, for credentials.ts's
// reason: a row naming a secret and an address, where only the secret is
// write-only, is an exfiltration primitive — repoint the address, press Run,
// read the key on your own server. A workflow is the worst instance of it,
// because the address is editable by dragging and by an agent calling
// change_step. So a step whose origin differs from the secret's is refused,
// at save and again at run; moving the address means deleting the secret and
// adding it again — destructive on purpose, that is what fails closed.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { WfGraph } from "../workflow/workflow.ts";
import { destinationOf, storeCredential, credentialFor, forgetCredential } from "./credentials.ts";

// Bounded where every per-owner thing is bounded, at a number nobody real
// reaches: a person integrating twenty different APIs is running a platform,
// not a workflow.
export const MAX_SECRETS_PER_OWNER: int = 20;
export const MAX_SECRET_NAME: int = 60;
// A value longer than this is a file, not a header.
export const MAX_SECRET_VALUE: int = 4096;

export type SecretRow = {
  id: string,
  // Whose it is. Every read and every write is scoped by this.
  owner: string,
  // What a person or a tool calls it: "stripe key", "weather api".
  name: string,
  // The header the value is sent in. The value is typed WHOLE ("Bearer
  // sk-...") so the graph never needs to know how a key is spelled.
  header: string,
  // The one origin the value may be sent to — scheme, host, port, as
  // destinationOf reads them. Never editable: a secret's address is
  // authorised the moment the secret is, and moving it means storing the
  // secret again.
  destination: string,
  createdAt: string,
  lastUsedAt: string,
};

export function secretsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("header", "header", "text"),
    field("destination", "destination", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return repository("secrets", "id", "id", fs);
}

export function secretsPlan(db: Db): Migration[] {
  // 109: triggers.ts owns up to 108, and a migration that sorts below one
  // already applied refuses the whole plan.
  return [
    migration("109", "secrets: a value a step may send but never hold",
      createTableSql(db, secretsMapping())),
  ];
}

export function emptySecret(): SecretRow {
  let none: SecretRow = {
    id: "", owner: "", name: "", header: "", destination: "",
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

// Where a secret's value lives in the credential store. Spelled in one place
// for forgetServer's reason: several callers each writing "secret:" + id is
// several chances to orphan an envelope.
function refOf(id: string): string {
  return "secret:" + id;
}

/** Why this secret cannot be stored, or "". The VALUE's rules live in
 *  credentials.ts (an empty key is not a credential; the master key must be
 *  usable) — this adds only what the row knows. */
export function refuseSecret(row: SecretRow): string {
  if (row.name.trim() == "") { return "a secret needs a name to be picked by"; }
  if (row.name.length > MAX_SECRET_NAME) { return "\"" + row.name.slice(0, 20) + "...\" is too long a name"; }
  if (row.owner == "") { return "a secret has to belong to somebody"; }
  let header = row.header.trim();
  if (header == "" || header.indexOf(" ") >= 0 || header.indexOf(":") >= 0) {
    return "\"" + row.header + "\" is not a header name — one word, like \"Authorization\" or \"X-Api-Key\"";
  }
  if (destinationOf(row.destination) != row.destination || row.destination == "") {
    return "a secret needs the address it may be sent to, as an origin — like \"https://api.stripe.com\"";
  }
  return "";
}

/** This owner's secrets, named, never valued. */
export function secretsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [asc("name")];
  return listOrdered(db, secretsMapping(), "owner = " + db.placeholder, [owner], keys);
}

/** One secret, if it is this owner's. Somebody else's is absent, not
 *  forbidden — the workflow rule, held here too. */
export function secretById(db: Db, id: string, owner: string): SecretRow {
  let doc = findById(db, secretsMapping(), id);
  if (doc == "") { return emptySecret(); }
  let row: SecretRow = JSON.parse<SecretRow>(doc);
  if (row.owner != owner) { return emptySecret(); }
  return row;
}

/** This owner's secret with this name, or empty. Names are how a sentence
 *  refers to a secret, so they are unique per owner — enforced here, where
 *  the lookup is, rather than hoped about at create. */
export function secretByName(db: Db, name: string, owner: string): SecretRow {
  let rows = JSON.parse<SecretRow[]>(secretsOf(db, owner));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].name.toLowerCase() == name.trim().toLowerCase()) { return rows[i]; }
    i = i + 1;
  }
  return emptySecret();
}

export type SecretWrite = {
  owner: string,
  name: string,
  // Typed whole, stored encrypted, never read back by any route.
  value: string,
  // A full URL is accepted and only its origin kept — the origin is what
  // decides who receives the bytes.
  destination: string,
  // "" means Authorization.
  header: string,
  master: string,
  now: string,
};

export type SecretMade = {
  id: string,
  problem: string,
};

/** Store a secret: the row and the value together, or neither.
 *
 *  The value goes through credentials.ts and is refused there for
 *  credentials.ts's reasons; the row is only written once the value is
 *  encrypted, so there is never a named secret that opens to nothing. */
export function createSecret(db: Db, ask: SecretWrite): SecretMade {
  let row: SecretRow = {
    id: crypto.randomUUID(),
    owner: ask.owner,
    name: ask.name.trim(),
    header: ask.header.trim() == "" ? "Authorization" : ask.header.trim(),
    destination: destinationOf(ask.destination),
    createdAt: ask.now,
    lastUsedAt: "",
  };
  // Every refusal builds its own answer rather than editing one: a record is
  // immutable here, so `refused.problem = ...` does not compile at all.
  let wrong = refuseSecret(row);
  if (wrong != "") { return { id: "", problem: wrong }; }
  if (ask.value.length > MAX_SECRET_VALUE) {
    return { id: "", problem: "that value is " + `${ask.value.length}` + " characters — the most a secret may hold is " + `${MAX_SECRET_VALUE}` };
  }
  if (secretByName(db, row.name, ask.owner).id != "") {
    return { id: "", problem: "there is already a secret called \"" + row.name + "\" — delete it first, or pick another name" };
  }
  let rows = JSON.parse<SecretRow[]>(secretsOf(db, ask.owner));
  if (rows.length >= MAX_SECRETS_PER_OWNER) {
    return { id: "", problem: "that is " + `${MAX_SECRETS_PER_OWNER}` + " secrets already — delete one before adding another" };
  }
  let stored = storeCredential(db, {
    provider: refOf(row.id), apiKey: ask.value, masterKey: ask.master, now: ask.now,
  });
  if (stored != "") { return { id: "", problem: stored }; }
  let written = persistRow(db, row);
  if (written != "") {
    // The row failed after the envelope was written; take the envelope back
    // out rather than leaving an orphan nothing can name.
    forgetCredential(db, refOf(row.id));
    return { id: "", problem: written };
  }
  let made: SecretMade = { id: row.id, problem: "" };
  return made;
}

// persist() answers a record; this module's callers all want the sentence.
function persistRow(db: Db, row: SecretRow): string {
  let written = persist(db, secretsMapping(), JSON.stringify(row));
  if (!written.ok) { return written.error; }
  return "";
}

/** Delete a secret and its envelope together — forgetServer's rule: a
 *  credential outliving the row that named it is a leak waiting for an id
 *  to be recycled. True when there was one to delete. */
export function forgetSecret(db: Db, id: string, owner: string): bool {
  let row = secretById(db, id, owner);
  if (row.id == "") { return false; }
  deleteById(db, secretsMapping(), id);
  forgetCredential(db, refOf(id));
  return true;
}

/** The value, opened with the master key — "" when there is none, the key is
 *  wrong, or the row was altered, indistinguishably (credentials.ts's rule).
 *  Called by the runner only; no route answers this. */
export function secretValue(db: Db, row: SecretRow, master: string): string {
  return credentialFor(db, refOf(row.id), master);
}

/** Stamp a use, so the list can say which secrets are alive and which are
 *  candidates to delete. Best-effort: a run must not fail over a stamp. */
export function touchSecret(db: Db, id: string, now: string): void {
  db.query("UPDATE secrets SET last_used_at = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [now, id]);
}

/** Everything wrong with how this graph uses secrets, or "".
 *
 *  Run on every graph write, beside refuseWorkflow — it needs the database
 *  and the owner, which the pure package rightly does not have. The origin
 *  is compared UNFILLED: a templated origin ("https://{{prev}}/...") never
 *  equals a stored one, so a URL whose host a previous step chooses refuses
 *  by construction rather than by a rule somebody had to remember. */
export function graphSecretProblem(db: Db, graph: WfGraph, owner: string): string {
  let i: int = 0;
  while (i < graph.nodes.length) {
    let node = graph.nodes[i];
    let id = node.secretId ?? "";
    if (node.type == "HTTP" && id != "") {
      let label = node.name == "" ? node.id : node.name;
      let row = secretById(db, id, owner);
      if (row.id == "") {
        return label + " names a secret that is not here — list_secrets says which exist, or pick one in the step's settings";
      }
      let to = destinationOf(node.url);
      if (to != row.destination) {
        return label + " sends to " + (to == "" ? "an address this cannot read" : to)
          + ", and \"" + row.name + "\" was stored for " + row.destination
          + " — a secret is only sent to the address it was stored for."
          + " Delete the secret and add it again if the address has moved.";
      }
    }
    i = i + 1;
  }
  return "";
}

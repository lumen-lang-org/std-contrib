import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { WfGraph, secretIds } from "../workflow/workflow.ts";
import { destinationOf, storeCredential, credentialFor, forgetCredential } from "./credentials.ts";

export const MAX_SECRETS_PER_OWNER: int = 20;
export const MAX_SECRET_NAME: int = 60;
export const MAX_SECRET_VALUE: int = 4096;

export type SecretRow = {
  id: string,
  owner: string,
  name: string,
  header: string,
  destination: string,
  category?: string,
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
    field("category", "category", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return repository({ table: "secrets", idField: "id", idColumn: "id", fields: fs });
}

export function secretsPlan(db: Db): Migration[] {
  return [
    migration("109", "secrets: a value a step may send but never hold",
      createTableSqlV1(db)),
    migration("109.1", "and what it is filed under",
      "ALTER TABLE secrets ADD COLUMN category " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

export function emptySecret(): SecretRow {
  let none: SecretRow = {
    id: "", owner: "", name: "", header: "", destination: "", category: "",
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

function createTableSqlV1(db: Db): string {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("header", "header", "text"),
    field("destination", "destination", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return createTableSql(db, repository({
    table: "secrets",
    idField: "id",
    idColumn: "id",
    fields: fs,
  }));
}

function refOf(id: string): string {
  return "secret:" + id;
}

export function refuseSecret(row: SecretRow): string {
  if (row.name.trim() == "") {
    return "a secret needs a name to be picked by";
  }
  if (row.name.length > MAX_SECRET_NAME) {
    return "\"" + row.name.slice(0, 20) + "...\" is too long a name";
  }
  if (row.owner == "") {
    return "a secret has to belong to somebody";
  }
  let header = row.header.trim();
  if (header == "" || header.indexOf(" ") >= 0 || header.indexOf(":") >= 0) {
    return "\"" + row.header + "\" is not a header name — one word, like \"Authorization\" or \"X-Api-Key\"";
  }
  if (destinationOf(row.destination) != row.destination || row.destination == "") {
    return "a secret needs the address it may be sent to, as an origin — like \"https://api.stripe.com\"";
  }
  return "";
}

export function secretsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "name" }];
  return listOrdered(db, secretsMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

export function secretById(db: Db, id: string, owner: string): SecretRow {
  let doc = findById(db, secretsMapping(), id);
  if (doc == "") {
    return emptySecret();
  }
  let row: SecretRow = JSON.parse<SecretRow>(doc);
  if (row.owner != owner) {
    return emptySecret();
  }
  return row;
}

export function secretByName(db: Db, name: string, owner: string): SecretRow {
  let rows = JSON.parse<SecretRow[]>(secretsOf(db, owner));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].name.toLowerCase() == name.trim().toLowerCase()) {
      return rows[i];
    }
    i = i + 1;
  }
  return emptySecret();
}

export type SecretWrite = {
  owner: string,
  name: string,
  value: string,
  destination: string,
  header: string,
  category: string,
  master: string,
  now: string,
};

export type SecretMade = {
  id: string,
  fault: string,
};

export function createSecret(db: Db, ask: SecretWrite): SecretMade {
  let row: SecretRow = {
    id: crypto.randomUUID(),
    owner: ask.owner,
    name: ask.name.trim(),
    header: ask.header.trim() == "" ? "Authorization" : ask.header.trim(),
    destination: destinationOf(ask.destination),
    category: ask.category.trim(),
    createdAt: ask.now,
    lastUsedAt: "",
  };
  let wrong = refuseSecret(row);
  if (wrong != "") {
    return { id: "", fault: wrong };
  }
  if (ask.value.length > MAX_SECRET_VALUE) {
    return {
      id: "",
      fault: "that value is " + `${ask.value.length}` + " characters — the most a secret may hold is " + `${MAX_SECRET_VALUE}`,
    };
  }
  if (secretByName(db, row.name, ask.owner).id != "") {
    return {
      id: "",
      fault: "there is already a secret called \"" + row.name + "\" — delete it first, or pick another name",
    };
  }
  let rows = JSON.parse<SecretRow[]>(secretsOf(db, ask.owner));
  if (rows.length >= MAX_SECRETS_PER_OWNER) {
    return {
      id: "",
      fault: "that is " + `${MAX_SECRETS_PER_OWNER}` + " secrets already — delete one before adding another",
    };
  }
  let stored = storeCredential(db, {
    provider: refOf(row.id), apiKey: ask.value, masterKey: ask.master, now: ask.now,
  });
  if (stored != "") {
    return { id: "", fault: stored };
  }
  let written = persistRow(db, row);
  if (written != "") {
    forgetCredential(db, refOf(row.id));
    return { id: "", fault: written };
  }
  let made: SecretMade = { id: row.id, fault: "" };
  return made;
}

function persistRow(db: Db, row: SecretRow): string {
  let written = persist(db, secretsMapping(), JSON.stringify(row));
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function forgetSecret(db: Db, id: string, owner: string): bool {
  let row = secretById(db, id, owner);
  if (row.id == "") {
    return false;
  }
  deleteById(db, secretsMapping(), id);
  forgetCredential(db, refOf(id));
  return true;
}

export function secretValue(db: Db, row: SecretRow, master: string): string {
  return credentialFor(db, refOf(row.id), master);
}

export function touchSecret(db: Db, id: string, now: string): void {
  db.query("UPDATE secrets SET last_used_at = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [now, id]);
}

export function graphSecretFault(db: Db, graph: WfGraph, owner: string): string {
  let i: int = 0;
  while (i < graph.nodes.length) {
    let node = graph.nodes[i];
    let label = node.name == "" ? node.id : node.name;
    let held = secretIds(node);
    let s: int = 0;
    while (s < held.length) {
      let row = secretById(db, held[s], owner);
      if (row.id == "") {
        return label + " names a secret that is not here — list_secrets says which exist, or pick one in the step's settings";
      }
      if (node.url.trim() != "") {
        let to = destinationOf(node.url);
        if (to != row.destination) {
          return label + " sends to " + (to == "" ? "an address this cannot read" : to)
            + ", and \"" + row.name + "\" was stored for " + row.destination
            + " — a secret is only sent to the address it was stored for."
            + " Delete the secret and add it again if the address has moved.";
        }
      }
      s = s + 1;
    }
    i = i + 1;
  }
  return "";
}

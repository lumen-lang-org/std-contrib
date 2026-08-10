// Checkpoints in a database table, through plume.
//
// The contract in checkpointstore.ts left this to the database package because
// the store is four functions over strings and needs nothing an agent knows.
// This is that implementation, and it works against PostgreSQL, SQLite and
// MySQL alike, since plume's operations do.
//
// It lives in the ai package rather than in plume so that plume stays a mapper
// with no idea what an agent is, and so that a program that imports the agent
// package does not link a database driver unless it imports this file.
//
//   import { postgres } from "../../plume/postgres.ts";
//   import { dbCheckpointStore } from "./checkpointdb.ts";
//
//   let database = postgres();
//   connectDatabase(database, "host=127.0.0.1 dbname=app");
//   let store = dbCheckpointStore(database, "agent_checkpoints");
//   createCheckpointTable(store);

import { CheckpointStore, storeKeyOk } from "./checkpointstore.ts";
import { Db } from "../../plume/driver.ts";
import { DbRepository, DbField, field, repository, createTable, persist, findById, deleteById, existsById, jsonMember } from "../../plume/plume.ts";

// The mapping is two columns, written out like any other plume mapping. A
// checkpoint's value is already JSON, so it is stored as text rather than
// being taken apart — the store's contract is over opaque strings.
export type CheckpointRow = {
  key: string,
  value: string,
};

export function checkpointRepository(table: string): DbRepository {
  let fields: DbField[] = [
    field("key", "checkpoint_key", "text"),
    field("value", "checkpoint_value", "text"),
  ];
  return repository({ table: table, idField: "key", idColumn: "checkpoint_key", fields: fields });
}

function dbPut(db: Db, table: string, key: string, value: string): bool {
  let row: CheckpointRow = { key: key, value: value };
  return persist(db, checkpointRepository(table), JSON.stringify(row)).ok;
}

function dbGet(db: Db, table: string, key: string): string {
  let json = findById(db, checkpointRepository(table), key);
  if (json == "") { return ""; }
  // The row comes back as a document; the stored value is one member of it,
  // and reading it out avoids parsing a checkpoint the caller has not asked
  // to have parsed.
  let member = jsonMember(json, "value");
  if (member.length >= 2 && member.startsWith("\"") && member.endsWith("\"")) {
    let inner: CheckpointRow = JSON.parse<CheckpointRow>(json);
    return inner.value;
  }
  return member;
}

// Checkpoints in `table`. The table is created by createCheckpointTable rather
// than on first write, so a store that cannot write says so instead of trying
// to alter the schema underneath a running agent.
export function dbCheckpointStore(db: Db, table: string): CheckpointStore {
  let store: CheckpointStore = {
    put: (key: string, value: string) => {
      if (!storeKeyOk(key)) { return false; }
      return dbPut(db, table, key, value);
    },
    get: (key: string) => {
      if (!storeKeyOk(key)) { return ""; }
      return dbGet(db, table, key);
    },
    del: (key: string) => {
      if (!storeKeyOk(key)) { return false; }
      return deleteById(db, checkpointRepository(table), key).ok;
    },
    has: (key: string) => {
      if (!storeKeyOk(key)) { return false; }
      return existsById(db, checkpointRepository(table), key);
    },
  };
  return store;
}

// Create the table the store reads and writes. Separate from the store so a
// deployment can create it through a migration instead.
export function createCheckpointTable(db: Db, table: string): bool {
  return createTable(db, checkpointRepository(table)).ok;
}

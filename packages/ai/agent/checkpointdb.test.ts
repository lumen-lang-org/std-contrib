// The database checkpoint store against a live database. A store is a promise
// that a value written now is readable after the process that wrote it is
// gone, and only a real database keeps that promise.
//
//   sh packages/plume/build.sh
//   cd packages/ai/agent && lumen test checkpointdb.test.ts

import { CheckpointStore, storeKeyOk } from "./checkpointstore.ts";
import { Db } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, dropTable, execute } from "../../plume/plume.ts";
import { dbCheckpointStore, createCheckpointTable, checkpointRepository } from "./checkpointdb.ts";

let database: Db = sqlite();

function storeTable(): string {
  return "ai_checkpoints_test";
}

function freshStore(): CheckpointStore {
  connectDatabase(database, "/tmp/ai_checkpointdb_test.db");
  dropTable(database, checkpointRepository(storeTable()));
  createCheckpointTable(database, storeTable());
  return dbCheckpointStore(database, storeTable());
}

test("a checkpoint written is a checkpoint read", () => {
  let store = freshStore();
  expect(store.put("run-1", "{\"step\":3}"));
  expect(store.has("run-1"));
  expect(store.get("run-1") == "{\"step\":3}");
});

test("a missing key reads as empty rather than raising", () => {
  let store = freshStore();
  expect(!store.has("absent"));
  expect(store.get("absent") == "");
});

test("writing the same key replaces rather than duplicating", () => {
  let store = freshStore();
  expect(store.put("run-1", "first"));
  expect(store.put("run-1", "second"));
  expect(store.get("run-1") == "second");
});

test("a checkpoint is deleted by key", () => {
  let store = freshStore();
  store.put("run-1", "x");
  expect(store.del("run-1"));
  expect(!store.has("run-1"));
});

test("a key that could escape a file store is refused here too", () => {
  let store = freshStore();
  // The same rule as the file store, so a program can change backend without
  // discovering that a key it has always used is now accepted or now is not.
  expect(!storeKeyOk("../escape"));
  expect(!store.put("../escape", "x"));
  expect(!store.has("../escape"));
});

test("a value containing quotes, braces and newlines survives", () => {
  let store = freshStore();
  let awkward = "{\"note\":\"it's \\\"quoted\\\"\",\"lines\":\"a\\nb\"}";
  expect(store.put("run-2", awkward));
  expect(store.get("run-2") == awkward);
});

test("an empty value is stored and read back as empty, not as missing", () => {
  let store = freshStore();
  expect(store.put("run-3", ""));
  expect(store.has("run-3"));
  expect(store.get("run-3") == "");
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, "/tmp/ai_checkpointdb_test.db");
  expect(dropTable(database, checkpointRepository(storeTable())).ok);
  database.close();
});

// The checkpoint stores: both backends honour the same contract.

import { fileCheckpointStore, memoryCheckpointStore, storeKeyOk } from "./checkpointstore.ts";

const STORE_DIR = "/tmp/lumen-ai-store-test";

function csReset(): void {
  if (fs.existsSync(STORE_DIR)) { fs.rmSync(STORE_DIR, true); }
}

test("keys are restricted to names safe everywhere", () => {
  expect(storeKeyOk("run-1.checkpoint.json"));
  expect(storeKeyOk("mailer.decision"));
  expect(!storeKeyOk("../escape"));
  expect(!storeKeyOk("a/b"));
  expect(!storeKeyOk(".hidden"));
  expect(!storeKeyOk(""));
});

test("the file store round-trips and deletes", () => {
  csReset();
  let s = fileCheckpointStore(STORE_DIR);
  expect(!s.has("k"));
  expect(s.put("k", "value"));
  expect(s.has("k"));
  expect(s.get("k") == "value");
  expect(s.del("k"));
  expect(!s.has("k"));
  expect(s.get("k") == "");
  expect(!s.del("k"));
});

test("the file store refuses an unsafe key", () => {
  csReset();
  let s = fileCheckpointStore(STORE_DIR);
  expect(!s.put("../escape", "x"));
  expect(s.get("a/b") == "");
});

test("the memory store honours the same contract", () => {
  let s = memoryCheckpointStore();
  expect(!s.has("k"));
  expect(s.put("k", "value"));
  expect(s.get("k") == "value");
  expect(s.del("k"));
  expect(!s.has("k"));
  expect(!s.del("k"));
});

test("two memory stores are independent", () => {
  let a = memoryCheckpointStore();
  let b = memoryCheckpointStore();
  a.put("k", "from-a");
  expect(b.get("k") == "");
});

// The indexing worker: claim a job, embed it, record what happened, repeat.
//
//   AGENTS_PG_HOST=db LUMEN_MASTER_KEY=… indexer
//
// A separate process rather than a Worker.run thread. This language does have
// real OS threads, but a worker function may not throw — `Worker.run` takes
// `() => T` and anything calling fs, JSON.parse, the database or an HTTP
// endpoint is typed `error{LumenThrow}!T`, which the checker refuses.
// Indexing does all four. A process also lets the queue be drained by more
// machines than the one serving requests, which is the point of a queue.
//
// Two of these can run against one database: the claim is atomic and SKIP
// LOCKED hands the second worker the next row rather than making it wait.

import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { connectDatabase } from "../plume/plume.ts";
import { embeddingModel, uploadDocument } from "./knowledge.ts";
import { claimNext, markIndexed, markFailed, requeueStalled, JOB_QUEUED } from "./indexing.ts";
import { masterKey, credentialFor } from "./credentials.ts";

// How long to sleep when the queue is empty. Long enough not to hammer the
// database, short enough that an upload feels queued rather than forgotten.
const IDLE_MS: int = 1000;

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.error("LUMEN_MASTER_KEY is not set — the worker cannot read provider credentials");
    return;
  }

  let db = postgres();
  let server: DbConfig = {
    host: process.env("AGENTS_PG_HOST") ?? "127.0.0.1",
    database: process.env("AGENTS_PG_DATABASE") ?? "agents",
    user: process.env("AGENTS_PG_USER") ?? "agents",
    password: process.env("AGENTS_PG_PASSWORD") ?? "",
  };
  connectDatabase(db, server);

  // No migrations here. The API owns the schema: plume refuses a plan that
  // does not account for every migration already recorded, and this worker
  // knows about a subset of the tables — so running its own plan would fail
  // against a database the API had already set up. If the tables are not
  // there yet, `claimNext` finds nothing and the next tick tries again.

  // A worker that died mid-job left its row claimed. Nothing else will ever
  // pick it up, so the first thing a starting worker does is put those back.
  requeueStalled(db, "");
  console.log("indexer: draining the queue");

  // A plain loop, paced by process.sleep. This was an interval callback until
  // process.sleep existed (spec 475) — which meant a `try` inside the lambda,
  // because a throw does not cross one. A loop in a function catches
  // ordinarily, which is the shape this wants.
  while (true) {
    try { drainOne(db, master); }
    catch (e) { console.error("indexer: " + e.message); }
    process.sleep(IDLE_MS);
  }
}

// One job, or nothing if the queue is empty. Returns rather than loops, so a
// failure costs one document and the next tick carries on.
function drainOne(db: Db, master: string): void {
  let job = claimNext(db, now());
  if (job.id == "") { return; }

  let embedder = embeddingModel(db, job.modelId);
  if (embedder.id == "") {
    markFailed(db, job.id, "no usable embedding model " + job.modelId, now());
    return;
  }
  let key = credentialFor(db, embedder.provider, master);
  if (key == "") {
    markFailed(db, job.id, "no credential for " + embedder.provider, now());
    return;
  }

  console.log("indexing " + job.source + " into " + job.scope);
  let stored = uploadDocument(db, embedder, job.source, job.scope, job.body, key);
  if (!stored.ok) {
    markFailed(db, job.id, stored.error, now());
    console.log("  failed: " + stored.error);
    return;
  }
  markIndexed(db, job.id, stored.chunks, now());
  console.log("  " + `${stored.chunks}` + " chunks");
}

function now(): string {
  return `${Date.now()}`;
}

main();

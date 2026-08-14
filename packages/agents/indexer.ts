import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { connectDatabase } from "../plume/plume.ts";
import { embeddingModel, uploadDocument } from "./knowledge.ts";
import { claimNext, markIndexed, markFailed, requeueStalled } from "./indexing.ts";
import { JOB_QUEUED } from "./routes/jobs/entities/index-job.entity.ts";
import { masterKey, credentialFor } from "./credentials.ts";

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

  requeueStalled(db, "");
  console.log("indexer: draining the queue");

  while (true) {
    try {
      drainOne(db, master);
    }
    catch (e) {
      console.error("indexer: " + e.message);
    }
    process.sleep(IDLE_MS);
  }
}

function drainOne(db: Db, master: string): void {
  let job = claimNext(db, now());
  if (job.id == "") {
    return;
  }

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

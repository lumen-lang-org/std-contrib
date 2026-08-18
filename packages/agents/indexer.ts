import { Db, DbConfig } from "../plume/driver.ts";
import { postgres } from "../plume/postgres.ts";
import { DbResult, connectDatabase } from "../plume/plume.ts";
import { embeddingModel, uploadDocument } from "./knowledge.ts";
import { JobRepository } from "./routes/knowledge/jobs/job.repository.ts";
import { JOB_QUEUED } from "./routes/knowledge/jobs/entities/index-job.entity.ts";
import { masterKey, credentialFor } from "./credentials.ts";

const IDLE_MS: int = 1000;

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.error("LUMEN_MASTER_KEY is not set — the worker cannot read provider credentials");
    return;
  }

  let db = postgres();
  let host = process.env("AGENTS_PG_HOST") ?? "127.0.0.1";
  let named = process.env("AGENTS_PG_DATABASE") ?? "agents";
  let asUser = process.env("AGENTS_PG_USER") ?? "agents";
  let server: DbConfig = {
    host: host,
    database: named,
    user: asUser,
    password: process.env("AGENTS_PG_PASSWORD") ?? "",
  };
  let reached = connectDatabase(db, server);
  if (!reached.ok) {
    console.error("indexer: the database did not open: postgres " + named + " at "
      + host + " as " + asUser + " — " + reached.error);
    return;
  }

  // Jobs left mid-flight by a previous run. Failing here is not fatal — new
  // work still drains — but those rows stay stuck on "indexing" and nothing
  // else ever picks them up, so it has to be said.
  let requeued = new JobRepository(db).requeueStalled("");
  if (!requeued.ok) {
    console.error("indexer: jobs left running by an earlier pass were not requeued — "
      + requeued.error);
  }
  console.log("indexer: draining the queue");

  while (true) {
    let worked = false;
    try {
      worked = drainOne(db, master);
    }
    catch (e) {
      console.error("indexer: " + e.message);
    }
    // Idle only when the queue is empty. This slept after every document too,
    // which put a second of doing nothing between each one: of the 2.83s a
    // document measured end to end, a full second was this line.
    if (!worked) {
      process.sleep(IDLE_MS);
    }
  }
}

/** A job whose terminal status does not land stays on "indexing" for good:
 *  claimNext only ever takes queued rows, so nothing picks it up again until
 *  a restart requeues it. Said out loud, naming the job, because the row
 *  itself can no longer say it. */
function noteStatus(id: string, what: string, wrote: DbResult): void {
  if (!wrote.ok) {
    console.error("indexer: job " + id + " could not be marked " + what
      + " and is left running — " + wrote.error);
  }
}

/** True when a job was claimed, so the caller knows whether to idle. */
function drainOne(db: Db, master: string): bool {
  let jobs = new JobRepository(db);
  let job = jobs.claimNext(now());
  if (job.id == "") {
    return false;
  }

  let embedder = embeddingModel(db, job.modelId);
  if (embedder.id == "") {
    noteStatus(job.id, "failed", jobs.markFailed(job.id, "no usable embedding model " + job.modelId, now()));
    return true;
  }
  let key = credentialFor(db, embedder.provider, master);
  if (key == "") {
    noteStatus(job.id, "failed", jobs.markFailed(job.id, "no credential for " + embedder.provider, now()));
    return true;
  }

  console.log("indexing " + job.source + " into " + job.scope);
  let stored = uploadDocument(db, embedder, job.owner, job.source, job.scope, job.body, key);
  if (!stored.ok) {
    noteStatus(job.id, "failed", jobs.markFailed(job.id, stored.error, now()));
    console.log("  failed: " + stored.error);
    return true;
  }
  noteStatus(job.id, "indexed", jobs.markIndexed(job.id, stored.chunks, now()));
  console.log("  " + `${stored.chunks}` + " chunks");
  return true;
}

function now(): string {
  return `${Date.now()}`;
}

main();

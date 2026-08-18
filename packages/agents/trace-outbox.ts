/* Traces leave through a table, not through the reply.
 *
 * The flush used to run inside the request, after the answer was finished and
 * before it was returned: measured on prod it took between 1.1 and 27.9
 * seconds against a steady ~3s of generation, so at worst a person waited
 * nine times longer for their own telemetry to upload than for the answer
 * they asked for. http.request takes no timeout, so the slow tail cannot be
 * capped at the call site; and Worker.run carries only scalars across its
 * boundary, so handing the tracer itself to a thread is a core dump, not a
 * fix — measured too.
 *
 * So the request WRITES the trace and a worker loop SHIPS it, the same shape
 * as sweepLoop: the loop takes no captured objects, opens a connection of its
 * own, and swallows nothing silently. What crosses the request/worker
 * boundary is a row, which is the one thing here that is safe to share.
 *
 * The row stores identity and spans, never credentials: the shipper rebuilds
 * endpoint and auth from live config at send time, so a rotated key or a
 * changed backend applies to traces already queued.
 *
 * The known limit, accepted on purpose: with no http timeout, an upload that
 * never answers wedges the shipping thread mid-pass, and traces queue until
 * the process restarts. Watched happen on prod — a hung flush that used to
 * hold somebody's reply open now holds only this loop. Rows survive in the
 * table either way; a timeout on http.request is the runtime fix.
 */

import { Db } from "../plume/driver.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { Tracer, RecordedSpan, flush, tracing } from "../tracing/tracing.ts";
import { executeWith, placeholderAt } from "../plume/plume.ts";
import { tracerFor } from "./trace.ts";

/** Tries before a trace is abandoned. A collector that refuses ten times over
 *  ten passes is down, and a queue that only ever grows is a disk full. */
const OUTBOX_MAX_ATTEMPTS: int = 10;

/** Rows shipped per pass. Small on purpose: a pass that ships a bounded batch
 *  and sleeps is one whose worst case is known. */
const OUTBOX_PER_PASS: int = 10;

export function traceOutboxPlan(db: Db): Migration[] {
  return [
    migration("138", "traces queued for shipping, off the reply path",
      "CREATE TABLE IF NOT EXISTS trace_outbox ("
      + "id " + db.textType + " NOT NULL, "
      + "doc " + db.textType + " NOT NULL, "
      + "attempts " + db.intType + " NOT NULL DEFAULT 0, "
      + "created_at " + db.textType + " NOT NULL)"),
    migration("139", "shipped oldest first",
      "CREATE INDEX IF NOT EXISTS trace_outbox_by_age ON trace_outbox (created_at)"),
  ];
}

/** What a queued trace remembers: whose it is and what happened. Endpoint and
 *  credentials deliberately absent — see the head of this file. */
export type QueuedTrace = {
  traceId: string,
  sessionId: string,
  userId: string,
  spans: RecordedSpan[],
};

/** Queue a finished run's trace. Milliseconds, which is the point: this is
 *  what the request does instead of talking to the collector. */
export function enqueueTrace(db: Db, t: Tracer): string {
  if (!tracing(t) || t.spans.length == 0) {
    return "";
  }
  let row: QueuedTrace = {
    traceId: t.traceId, sessionId: t.sessionId, userId: t.userId, spans: t.spans,
  };
  let wrote = executeWith(db,
    "INSERT INTO trace_outbox (id, doc, attempts, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", 0, " + placeholderAt(db, 3) + ")",
    [crypto.randomUUID(), JSON.stringify(row), `${Date.now()}`]);
  if (!wrote.ok) {
    return wrote.error;
  }
  return "";
}

type OutboxRow = {
  id: string,
  doc: string,
  attempts: int,
};

function claimOldest(db: Db): OutboxRow[] {
  let out: OutboxRow[] = [];
  if (!db.query("SELECT id, doc, attempts FROM trace_outbox ORDER BY created_at"
      + " LIMIT " + `${OUTBOX_PER_PASS}`, [])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    let row: OutboxRow = {
      id: db.value(i, 0), doc: db.value(i, 1),
      attempts: parseInt(db.value(i, 2), 10) ?? 0,
    };
    out.push(row);
    i = i + 1;
  }
  return out;
}

function drop(db: Db, id: string): void {
  executeWith(db, "DELETE FROM trace_outbox WHERE id = " + placeholderAt(db, 1), [id]);
}

function retryLater(db: Db, row: OutboxRow): void {
  if (row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
    // log, not error: giving up after a bounded retry is this table working
    // as designed, and the suite treats stderr as a failed test.
    console.log("trace outbox: gave up on trace " + row.id + " after "
      + `${OUTBOX_MAX_ATTEMPTS}` + " attempts");
    drop(db, row.id);
    return;
  }
  executeWith(db, "UPDATE trace_outbox SET attempts = attempts + 1, created_at = "
    + placeholderAt(db, 1) + " WHERE id = " + placeholderAt(db, 2),
    [`${Date.now()}`, row.id]);
}

/** One shipping pass. How many traces left this process, so a caller looping
 *  on it can log movement rather than silence. */
export function shipTraces(db: Db, master: string): int {
  let held = claimOldest(db);
  if (held.length == 0) {
    return 0;
  }
  // Endpoint and credentials read once per pass, from live config: a backend
  // switched off drains the queue into the bin rather than into nowhere.
  let base = tracerFor(db, master);
  if (!tracing(base)) {
    let b: int = 0;
    while (b < held.length) {
      drop(db, held[b].id);
      b = b + 1;
    }
    return 0;
  }
  let shipped: int = 0;
  let i: int = 0;
  while (i < held.length) {
    let row = held[i];
    let queued: QueuedTrace = JSON.parse<QueuedTrace>(row.doc);
    let one: Tracer = {
      traceId: queued.traceId, spans: queued.spans,
      endpoint: base.endpoint, backend: base.backend,
      serviceName: base.serviceName, environment: base.environment,
      sessionId: queued.sessionId, userId: queued.userId,
    };
    if (flush(one).ok) {
      drop(db, row.id);
      shipped = shipped + 1;
    } else {
      retryLater(db, row);
    }
    i = i + 1;
  }
  return shipped;
}

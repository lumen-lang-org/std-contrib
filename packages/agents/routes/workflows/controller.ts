import { Db } from "../../../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, accepted, badRequest, created, noContent, notFound, ok, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { jsonFlag, jsonRaw, jsonText } from "../../scan.ts";
import { agentsMapping } from "../../schema.ts";
import { ensureBuilt } from "../../script-wasm.ts";
import { graphSecretProblem } from "../../secrets.ts";
import { MAX_WORKFLOWS_PER_OWNER, WorkflowRow, emptyWorkflow, enabledWorkflowCount, nextWorkflowFire, parseGraph, refuseWorkflow, timingOf, withWorkflowNextAt, workflowRunsOf, workflowsMapping, workflowsOf } from "../../workflow-store.ts";

// The /workflows routes.

// Workflows: graphs of steps, drawn on the console's canvas or drafted in a
// conversation (workflow-tools.ts), fired by the scheduler.
//
// The same posture as TaskApi throughout: owner-scoped so a stranger's row is
// absent rather than forbidden, schedules compiled server-side from the words
// on the START step, and even "run now" a write that moves `next_at` — the
// scheduler stays the only place a workflow is claimed, walked and recorded.
@controller("/workflows")
export class WorkflowApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" && tags.length > 0) { return ok("[]"); }
    return ok(workflowsOf(this.db, owningTag(tags)));
  }

  // Create one from a whole document: name, description, graph. The schedule
  // is never a field of its own — it is the words on the graph's START step,
  // compiled here, so the canvas and the conversation cannot disagree about
  // where a schedule lives.
  @post("/")
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    // The task rule, for the task reason: a workflow is a standing instruction
    // with a provider's bill attached, and it has to belong to somebody.
    if (guestTag(tags) != "" || (owner == "" && tags.length > 0)) {
      return badRequest("signing in is what makes a workflow yours to keep");
    }
    if (req.body == "") {
      return badRequest("a body is required: {\"name\":\"...\",\"agentId\":\"a1\",\"graph\":{...}}");
    }
    let agentId = jsonText(req.body, "agentId");
    if (!existsById(this.db, agentsMapping(), agentId)) { return badRequest("no agent " + agentId); }
    if (enabledWorkflowCount(this.db, owner) >= MAX_WORKFLOWS_PER_OWNER) {
      return badRequest("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — pause one before adding another");
    }
    let graphText = jsonRaw(req.body, "graph");
    if (graphText == "") { return badRequest("a workflow needs a graph: nodes, edges and a view"); }
    let parsed = parseGraph(graphText);
    if (!parsed.ok) { return badRequest(parsed.error); }
    // The scalars are read from the body with the graph's bytes cut out.
    // jsonText scans flat and answers the FIRST occurrence of a key anywhere
    // in the document — and a graph is full of nodes carrying "name", so a
    // create whose graph preceded its name would call every workflow after
    // its first node. Four rows named "Start" found this on the PUT below.
    let bare = req.body;
    let graphAt = req.body.indexOf(graphText);
    if (graphAt >= 0) { bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + graphText.length); }
    let zone = jsonText(bare, "tz");
    let timing = timingOf(parsed.graph, zone == "" ? "UTC" : zone, Date.now() as number);
    if (!timing.ok) { return badRequest(timing.error); }

    let now = stamp();
    let row: WorkflowRow = {
      id: crypto.randomUUID(), owner: owner, agentId: agentId,
      modelChoiceId: "",
      name: jsonText(bare, "name"),
      description: jsonText(bare, "description"),
      graph: graphText,
      kind: timing.kind, cronExpr: timing.expr, tz: zone,
      nextAt: timing.kind == "once" ? timing.at : "",
      runningSince: "", enabled: true, failures: 0, pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0,
      // Born published: the graph was just validated whole, and a workflow
      // that runs nothing until a second button is pressed is a surprise.
      // The first DIVERGENCE is the first unpublished edit.
      publishedGraph: graphText, publishedAt: now,
      createdAt: now, updatedAt: now,
    };
    let wrong = refuseWorkflow(row);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let ready = row;
    if (row.kind == "every") {
      let first = nextWorkflowFire(row, Date.now() as number);
      if (!first.ok) { return badRequest(first.error); }
      ready = withWorkflowNextAt(row, first.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(ready));
    if (!written.ok) { return badRequest(written.error); }
    return created(findById(this.db, workflowsMapping(), ready.id));
  }

  @get("/:id")
  one(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    return ok(JSON.stringify(mine));
  }

  // The whole document again: the canvas saves what it is showing — graph,
  // name, description, enabled — and the schedule half is recompiled from the
  // START step it just drew. An `updatedAt` precondition refuses the stale
  // save instead of burying the newer one, which is what two tabs on one
  // workflow would otherwise silently do.
  @put("/:id")
  update(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    if (req.body == "") { return badRequest("a body is required"); }
    // The same flat-scanner discipline as create: everything scalar is read
    // from the body with the graph's bytes cut out, because the first "name"
    // in a body whose graph comes first is a NODE's name — and this route
    // was quietly renaming every canvas-saved workflow to "Start".
    let sentGraph = jsonRaw(req.body, "graph");
    let bare = req.body;
    if (sentGraph != "") {
      let graphAt = req.body.indexOf(sentGraph);
      if (graphAt >= 0) { bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + sentGraph.length); }
    }
    let expected = jsonText(bare, "updatedAt");
    if (expected != "" && expected != mine.updatedAt) {
      return badRequest("this workflow changed while you were editing — reload it and redo the change");
    }
    let graphText = sentGraph == "" ? mine.graph : sentGraph;
    let parsed = parseGraph(graphText);
    if (!parsed.ok) { return badRequest(parsed.error); }
    let zone = jsonText(bare, "tz");
    let tz = zone == "" ? mine.tz : zone;
    let timing = timingOf(parsed.graph, tz == "" ? "UTC" : tz, Date.now() as number);
    if (!timing.ok) { return badRequest(timing.error); }
    let name = jsonText(bare, "name");
    let description = jsonText(bare, "description");
    let on = jsonFlag(bare, "enabled", mine.enabled);

    let edited: WorkflowRow = {
      id: mine.id, owner: mine.owner, agentId: mine.agentId,
      modelChoiceId: mine.modelChoiceId,
      name: name == "" ? mine.name : name,
      description: description == "" ? mine.description : description,
      graph: graphText,
      kind: timing.kind, cronExpr: timing.expr, tz: tz,
      // A manual workflow KEEPS its next_at: the only way one gets a firing
      // is run-now, and the canvas PUTs the document on mount — so a save
      // that zeroed it was cancelling every "Run soon" within a second of
      // the button being pressed, and the spec caught it as a run that never
      // happened.
      nextAt: timing.kind == "once" ? timing.at
        : timing.kind == "manual" ? mine.nextAt : "",
      runningSince: mine.runningSince,
      enabled: on,
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount,
      // The autosave never touches what production runs. Only /publish does.
      publishedGraph: mine.publishedGraph ?? "", publishedAt: mine.publishedAt ?? "",
      createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuseWorkflow(edited);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, Date.now() as number);
      if (!ahead.ok) { return badRequest(ahead.error); }
      stored = withWorkflowNextAt(edited, ahead.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(stored));
    if (!written.ok) { return badRequest(written.error); }
    return ok(findById(this.db, workflowsMapping(), stored.id));
  }

  // Compile a step's script and say whether it is sound, without running
  // anything.
  //
  // The console calls this a moment after the editor goes quiet, so a person
  // learns their script does not compile while they are looking at it —
  // rather than by running the workflow and reading the failure off the step.
  // It is the SAME call the run makes (`ensureBuilt`, keyed by the hash of
  // the source), so this is not a second compiler path and the check is not
  // wasted work: the module it builds is the one the run will use, which is
  // also why the first run stops being the slow one.
  //
  // Signed in only. Compiling is the one thing here that spends real time on
  // this machine, and an anonymous caller with a loop could spend all of it.
  @post("/script-check")
  scriptCheck(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" || guestTag(tags) != "") {
      return badRequest("signing in is what makes a script yours to compile");
    }
    if (req.body == "") { return badRequest("a body is required: {\"source\":\"...\"}"); }
    let source = jsonText(req.body, "source");
    if (source.trim() == "") {
      return ok("{\"ok\":false,\"error\":\"there is no script to compile\"}");
    }
    let built = ensureBuilt(source);
    if (!built.ok) {
      return ok("{\"ok\":false,\"error\":" + JSON.stringify(built.error) + "}");
    }
    return ok("{\"ok\":true,\"error\":\"\",\"fresh\":" + (built.fresh ? "true" : "false") + "}");
  }

  // The draft becomes what production runs — the one write site for
  // published_graph, which is what makes "publish" a word rather than a
  // hope. Messages and the clock walk this; the canvas keeps autosaving the
  // draft without touching it.
  @post("/:id/publish")
  publish(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    // Re-validated at the door even though every save validates: publish is
    // the moment the graph starts serving people, and a cheap second check
    // beats trusting that nothing ever wrote the column another way.
    let parsed = parseGraph(mine.graph);
    if (!parsed.ok) { return badRequest(parsed.error); }
    let wrong = refuseWorkflow(mine);
    if (wrong != "") { return badRequest(wrong); }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") { return badRequest(secretWrong); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET published_graph = graph, published_at = " + this.db.placeholder
      + ", updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return ok(findById(this.db, workflowsMapping(), mine.id));
  }

  // Fire it on the next tick — the task door's "run now", word for word.
  @post("/:id/run-now")
  runNow(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return accepted(findById(this.db, workflowsMapping(), mine.id));
  }

  // What happened when it ran, newest first — the canvas replays a run's
  // steps as node statuses straight off these rows.
  @get("/:id/runs")
  runs(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    return ok(workflowRunsOf(this.db, mine.id, mine.owner));
  }

  @del("/:id")
  remove(req: Request): Reply {
    let mine = this.owned(req);
    if (mine.id == "") { return notFound("workflow " + param(req, "id")); }
    executeWith(this.db, "DELETE FROM workflow_runs WHERE workflow_id = " + this.db.placeholder, [mine.id]);
    let gone = deleteById(this.db, workflowsMapping(), mine.id);
    if (!gone.ok) { return badRequest(gone.error); }
    return noContent();
  }

  private owned(req: Request): WorkflowRow {
    let document = findById(this.db, workflowsMapping(), param(req, "id"));
    if (document == "") { return emptyWorkflow(); }
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) { return emptyWorkflow(); }
    return row;
  }
}

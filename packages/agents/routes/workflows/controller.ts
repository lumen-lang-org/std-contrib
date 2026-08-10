import { Db } from "../../../plume/driver.ts";
import { deleteById, executeWith, existsById, findById, persist, placeholderAt } from "../../../plume/plume.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, Accepted, BadRequest, Created, NoContent, NotFound, Ok, OkJson, param } from "../../../rest/server.ts";
import { callerTags, guestTag, stamp } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { jsonFlag, jsonRaw, jsonText } from "../../scan.ts";
import { agentsMapping } from "../../schema.ts";
import { ensureBuilt } from "../../script-wasm.ts";
import { graphSecretProblem } from "../../secrets.ts";
import { MAX_WORKFLOWS_PER_OWNER, WorkflowRow, emptyWorkflow, enabledWorkflowCount, nextWorkflowFire, parseGraph, refuseWorkflow, timingOf, withWorkflowNextAt, workflowRunsOf, workflowsMapping, workflowsOf } from "../../workflow-store.ts";
import { ScriptCheckFailed, ScriptCheckFresh } from "./types.ts";
import { ownedOrEmpty, roleAtLeast } from "../../guards.ts";

@controller("/workflows")
@bindings
export class WorkflowApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @Get("/")
  @Guard(ownedOrEmpty)
  list(req: Request): Reply {
    let tags = callerTags(req);
    return Ok(workflowsOf(this.db, owningTag(tags)));
  }

  @Post("/")
  @Guard(roleAtLeast("signed-in", "signing in is what makes a workflow yours to keep"))
  create(req: Request): Reply {
    let tags = callerTags(req);
    let owner = owningTag(tags);
    if (req.body == "") {
      return BadRequest("a body is required: {\"name\":\"...\",\"agentId\":\"a1\",\"graph\":{...}}");
    }
    let agentId = jsonText(req.body, "agentId");
    if (!existsById(this.db, agentsMapping(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    if (enabledWorkflowCount(this.db, owner) >= MAX_WORKFLOWS_PER_OWNER) {
      return BadRequest("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — pause one before adding another");
    }
    let graphText = jsonRaw(req.body, "graph");
    if (graphText == "") {
      return BadRequest("a workflow needs a graph: nodes, edges and a view");
    }
    let parsed = parseGraph(graphText);
    if (!parsed.ok) {
      return BadRequest(parsed.error);
    }
    let bare = req.body;
    let graphAt = req.body.indexOf(graphText);
    if (graphAt >= 0) {
      bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + graphText.length);
    }
    let zone = jsonText(bare, "tz");
    let timing = timingOf(parsed.graph, zone == "" ? "UTC" : zone, Date.now() as number);
    if (!timing.ok) {
      return BadRequest(timing.error);
    }

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
      publishedGraph: graphText, publishedAt: now,
      createdAt: now, updatedAt: now,
    };
    let wrong = refuseWorkflow(row);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, owner);
    if (secretWrong != "") {
      return BadRequest(secretWrong);
    }
    let ready = row;
    if (row.kind == "every") {
      let first = nextWorkflowFire(row, Date.now() as number);
      if (!first.ok) {
        return BadRequest(first.error);
      }
      ready = withWorkflowNextAt(row, first.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(ready));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Created(findById(this.db, workflowsMapping(), ready.id));
  }

  @Get("/:id")
  one(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    return Ok(JSON.stringify(mine));
  }

  @Put("/:id")
  update(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    if (req.body == "") {
      return BadRequest("a body is required");
    }
    let sentGraph = jsonRaw(req.body, "graph");
    let bare = req.body;
    if (sentGraph != "") {
      let graphAt = req.body.indexOf(sentGraph);
      if (graphAt >= 0) {
        bare = req.body.slice(0, graphAt) + "\"\"" + req.body.slice(graphAt + sentGraph.length);
      }
    }
    let expected = jsonText(bare, "updatedAt");
    if (expected != "" && expected != mine.updatedAt) {
      return BadRequest("this workflow changed while you were editing — reload it and redo the change");
    }
    let graphText = sentGraph == "" ? mine.graph : sentGraph;
    let parsed = parseGraph(graphText);
    if (!parsed.ok) {
      return BadRequest(parsed.error);
    }
    let zone = jsonText(bare, "tz");
    let tz = zone == "" ? mine.tz : zone;
    let timing = timingOf(parsed.graph, tz == "" ? "UTC" : tz, Date.now() as number);
    if (!timing.ok) {
      return BadRequest(timing.error);
    }
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
      nextAt: timing.kind == "once" ? timing.at
        : timing.kind == "manual" ? mine.nextAt : "",
      runningSince: mine.runningSince,
      enabled: on,
      failures: on && !mine.enabled ? 0 : mine.failures,
      pausedReason: on ? "" : mine.pausedReason,
      lastRunAt: mine.lastRunAt, lastRunId: mine.lastRunId,
      lastStatus: mine.lastStatus, lastError: mine.lastError,
      runCount: mine.runCount,
      publishedGraph: mine.publishedGraph ?? "", publishedAt: mine.publishedAt ?? "",
      createdAt: mine.createdAt, updatedAt: stamp(),
    };
    let wrong = refuseWorkflow(edited);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") {
      return BadRequest(secretWrong);
    }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, Date.now() as number);
      if (!ahead.ok) {
        return BadRequest(ahead.error);
      }
      stored = withWorkflowNextAt(edited, ahead.at);
    }
    let written = persist(this.db, workflowsMapping(), JSON.stringify(stored));
    if (!written.ok) {
      return BadRequest(written.error);
    }
    return Ok(findById(this.db, workflowsMapping(), stored.id));
  }

  @Post("/script-check")
  scriptCheck(req: Request): Reply {
    let tags = callerTags(req);
    if (owningTag(tags) == "" || guestTag(tags) != "") {
      return BadRequest("signing in is what makes a script yours to compile");
    }
    if (req.body == "") {
      return BadRequest("a body is required: {\"source\":\"...\"}");
    }
    let source = jsonText(req.body, "source");
    if (source.trim() == "") {
      let empty: ScriptCheckFailed = { ok: false, error: "there is no script to compile" };
      return OkJson(empty);
    }
    let built = ensureBuilt(source);
    if (!built.ok) {
      let failed: ScriptCheckFailed = { ok: false, error: built.error };
      return OkJson(failed);
    }
    let done: ScriptCheckFresh = { ok: true, error: "", fresh: built.fresh };
    return OkJson(done);
  }

  @Post("/:id/publish")
  publish(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    let parsed = parseGraph(mine.graph);
    if (!parsed.ok) {
      return BadRequest(parsed.error);
    }
    let wrong = refuseWorkflow(mine);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let secretWrong = graphSecretProblem(this.db, parsed.graph, mine.owner);
    if (secretWrong != "") {
      return BadRequest(secretWrong);
    }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET published_graph = graph, published_at = " + this.db.placeholder
      + ", updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return Ok(findById(this.db, workflowsMapping(), mine.id));
  }

  @Post("/:id/run-now")
  runNow(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    let now = stamp();
    executeWith(this.db,
      "UPDATE workflows SET next_at = " + this.db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.db, 2)
      + " WHERE id = " + placeholderAt(this.db, 3),
      [now, now, mine.id]);
    return Accepted(findById(this.db, workflowsMapping(), mine.id));
  }

  @Get("/:id/runs")
  runs(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    return Ok(workflowRunsOf(this.db, mine.id, mine.owner));
  }

  @Delete("/:id")
  remove(req: Request, @PathVariable("id") id: string): Reply {
    let mine = this.owned(req);
    if (mine.id == "") {
      return NotFound("workflow " + id);
    }
    executeWith(this.db, "DELETE FROM workflow_runs WHERE workflow_id = " + this.db.placeholder, [mine.id]);
    let gone = deleteById(this.db, workflowsMapping(), mine.id);
    if (!gone.ok) {
      return BadRequest(gone.error);
    }
    return NoContent();
  }

  private owned(req: Request): WorkflowRow {
    let document = findById(this.db, workflowsMapping(), param(req, "id"));
    if (document == "") {
      return emptyWorkflow();
    }
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
    if (!holdsOwner(callerTags(req), row.owner)) {
      return emptyWorkflow();
    }
    return row;
  }
}

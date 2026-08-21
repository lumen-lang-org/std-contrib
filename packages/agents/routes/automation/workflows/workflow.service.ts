import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { holdsOwner } from "../../../owner.ts";
import { jsonFlag, jsonRaw, jsonText } from "../../../scan.ts";
import { ensureBuilt } from "../../../script-wasm.ts";
import { MAX_RUN_INPUT, MAX_WORKFLOWS_PER_OWNER, WorkflowRow, emptyWorkflow, nextWorkflowFire, parseGraph, refuseDraftWorkflow, refuseWorkflow, setNextInput, timingOf, withWorkflowNextAt } from "../../../workflow-store.ts";
import { ScriptCheckFailed } from "./dtos/script-check-failed.dto.ts";
import { ScriptCheckFresh } from "./dtos/script-check-fresh.dto.ts";
import { WorkflowRepository } from "./workflow.repository.ts";
import { withoutGraph } from "./workflow.utils.ts";

export class WorkflowService {
  repository: WorkflowRepository;

  constructor(database: Db) {
    this.repository = new WorkflowRepository(database);
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  owned(id: string, tags: string[]): WorkflowRow {
    let document = this.repository.one(id);
    if (document == "") {
      return emptyWorkflow();
    }
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
    if (!holdsOwner(tags, row.owner)) {
      return emptyWorkflow();
    }
    return row;
  }

  owns(id: string, tags: string[]): bool {
    return this.owned(id, tags).id != "";
  }

  one(id: string, tags: string[]): string {
    return JSON.stringify(this.owned(id, tags));
  }

  runs(id: string, tags: string[]): string {
    let mine = this.owned(id, tags);
    return this.repository.runs(mine.id, mine.owner);
  }

  create(owner: string, body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"name\":\"...\",\"agentId\":\"a1\",\"graph\":{...}}");
    }
    let agentId = jsonText(body, "agentId");
    if (!this.repository.hasAgent(agentId)) {
      return refusing("no agent " + agentId);
    }
    let running = this.repository.enabledCount(owner);
    if (running < 0) {
      return refusing("how many workflows are already running could not be counted, so this one is not being added");
    }
    if (running >= MAX_WORKFLOWS_PER_OWNER) {
      return refusing("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — pause one before adding another");
    }
    let graphText = jsonRaw(body, "graph");
    if (graphText == "") {
      return refusing("a workflow needs a graph: nodes, edges and a view");
    }
    let parsed = parseGraph(graphText);
    if (!parsed.ok) {
      return refusing(parsed.error);
    }
    let bare = withoutGraph(body, graphText);
    let zone = jsonText(bare, "tz");
    let timing = timingOf(parsed.graph, zone == "" ? "UTC" : zone, Date.now() as number);
    if (!timing.ok) {
      return refusing(timing.error);
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
      return refusing(wrong);
    }
    let secretWrong = this.repository.secretFault(parsed.graph, owner);
    if (secretWrong != "") {
      return refusing(secretWrong);
    }
    let ready = row;
    if (row.kind == "every") {
      let first = nextWorkflowFire(row, Date.now() as number);
      if (!first.ok) {
        return refusing(first.error);
      }
      ready = withWorkflowNextAt(row, first.at);
    }
    let written = this.repository.saveIfUnderCap(JSON.stringify(ready), owner, MAX_WORKFLOWS_PER_OWNER);
    if (!written.ok) {
      return refusing(written.error);
    }
    if (written.rows == 0) {
      return refusing("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — pause one before adding another");
    }
    return produced(this.repository.one(ready.id));
  }

  update(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    if (body == "") {
      return refusing("a body is required");
    }
    let sentGraph = jsonRaw(body, "graph");
    let bare = withoutGraph(body, sentGraph);
    let expected = jsonText(bare, "updatedAt");
    if (expected != "" && expected != mine.updatedAt) {
      return refusing("this workflow changed while you were editing — reload it and redo the change");
    }
    let graphText = sentGraph == "" ? mine.graph : sentGraph;
    let parsed = parseGraph(graphText);
    if (!parsed.ok) {
      return refusing(parsed.error);
    }
    let zone = jsonText(bare, "tz");
    let tz = zone == "" ? mine.tz : zone;
    let timing = timingOf(parsed.graph, tz == "" ? "UTC" : tz, Date.now() as number);
    if (!timing.ok) {
      return refusing(timing.error);
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
    let wrong = refuseDraftWorkflow(edited);
    if (wrong != "") {
      return refusing(wrong);
    }
    let secretWrong = this.repository.secretFault(parsed.graph, mine.owner);
    if (secretWrong != "") {
      return refusing(secretWrong);
    }
    let stored = edited;
    if (edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, Date.now() as number);
      if (!ahead.ok) {
        return refusing(ahead.error);
      }
      stored = withWorkflowNextAt(edited, ahead.at);
    }
    let written = this.repository.save(JSON.stringify(stored));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(stored.id));
  }

  compiled(body: string): string {
    let source = jsonText(body, "source");
    if (source.trim() == "") {
      let empty: ScriptCheckFailed = { ok: false, error: "there is no script to compile" };
      return JSON.stringify(empty);
    }
    let built = ensureBuilt(source);
    if (!built.ok) {
      let failed: ScriptCheckFailed = { ok: false, error: built.error };
      return JSON.stringify(failed);
    }
    let done: ScriptCheckFresh = { ok: true, error: "", fresh: built.fresh };
    return JSON.stringify(done);
  }

  publish(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let parsed = parseGraph(mine.graph);
    if (!parsed.ok) {
      return refusing(parsed.error);
    }
    let wrong = refuseWorkflow(mine);
    if (wrong != "") {
      return refusing(wrong);
    }
    let secretWrong = this.repository.secretFault(parsed.graph, mine.owner);
    if (secretWrong != "") {
      return refusing(secretWrong);
    }
    let now = stamp();
    let written = this.repository.publish(mine.id, mine.graph, now);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(mine.id));
  }

  runNow(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    // What the button was pressed with. Empty is what the clock passes, and
    // what this always passed before there was anywhere to type it.
    let said = body == "" ? "" : jsonText(body, "input");
    if (said.length > MAX_RUN_INPUT) {
      return refusing("that is more than a run may be started with ("
        + `${MAX_RUN_INPUT}` + " characters)");
    }
    if (!setNextInput(this.repository.database, mine.id, said)) {
      return refusing("what to run it with could not be stored");
    }
    let written = this.repository.markRunNow(mine.id, stamp());
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(mine.id));
  }

  forget(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let fault = this.repository.forget(mine.id);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }
}

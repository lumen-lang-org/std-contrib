import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { tracerBackend, tracing } from "../../../../tracing/tracing.ts";
import { stamp } from "../../../api-core.ts";
import { EvalItem, EvalRequest, EvalRun, NewCase, addCase, createDataset, datasetItems, datasetSummaries, caseRuns, datasetRuns, deleteCase, evalApiBase, hasDataset, runDetail, runEvals, updateCase } from "../../../evals.ts";
import { tracerFor } from "../../../trace.ts";
import { EvalCaseBody, EvalDatasetBody, EvalRunBody } from "./dtos/eval-bodies.dto.ts";

const MOST_CASES: int = 200;
const MOST_RUN: int = 25;

/** Where the cases are kept, or why they cannot be reached. */
export type EvalReach = {
  base: string,
  auth: string,
  fault: string,
};

export class EvalService {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  /** The cases live wherever the traces go, so a backend with no dataset API
   *  is the same answer as no tracing at all: there is nothing to read. */
  reach(): EvalReach {
    let tracer = tracerFor(this.database, this.master);
    if (!tracing(tracer)) {
      let off: EvalReach = {
        base: "", auth: "",
        fault: "tracing is off, and the cases are kept with the traces; configure it under Settings, Tracing",
      };
      return off;
    }
    let backend = tracerBackend(tracer);
    let base = evalApiBase(backend);
    if (base == "") {
      let plain: EvalReach = {
        base: "", auth: "",
        fault: "the \"" + backend.name + "\" backend keeps no datasets, so there is nowhere to put a case",
      };
      return plain;
    }
    let out: EvalReach = { base: base, auth: backend.authValue, fault: "" };
    return out;
  }

  datasets(): Outcome {
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    return produced(JSON.stringify(datasetSummaries(reach.base, reach.auth)));
  }

  addDataset(sent: string): Outcome {
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: EvalDatasetBody = JSON.parse<EvalDatasetBody>(sent);
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (body.name.trim() == "") {
      return refusing("name the set of cases");
    }
    if (!createDataset(reach.base, reach.auth, body.name.trim(), body.description)) {
      return refusing("the trace backend refused the set \"" + body.name.trim() + "\"");
    }
    return produced(JSON.stringify(datasetSummaries(reach.base, reach.auth)));
  }

  cases(dataset: string, limit: int): Outcome {
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (dataset.trim() == "") {
      return refusing("name the set of cases: ?dataset=parts-desk-evals");
    }
    let want = limit;
    if (want < 1 || want > MOST_CASES) {
      want = MOST_CASES;
    }
    let items: EvalItem[] = datasetItems(reach.base, reach.auth, dataset.trim(), want);
    return produced(JSON.stringify(items));
  }

  /** Adds one case, making the set on the way if it is new: a first case and a
   *  first set are the same act from the console, and asking someone to create
   *  an empty set first only moves the failure earlier. */
  addOne(sent: string): Outcome {
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: EvalCaseBody = JSON.parse<EvalCaseBody>(sent);
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    let dataset = body.dataset.trim();
    if (dataset == "") {
      return refusing("name the set this case belongs to");
    }
    if (body.question.trim() == "") {
      return refusing("a case needs a question");
    }
    if (body.expected.trim() == "") {
      return refusing("a case needs the answer to compare against");
    }
    if (!hasDataset(datasetSummaries(reach.base, reach.auth), dataset)) {
      if (!createDataset(reach.base, reach.auth, dataset, "Created from the Joule console.")) {
        return refusing("the trace backend refused the set \"" + dataset + "\"");
      }
    }
    let made: NewCase = {
      dataset: dataset,
      question: body.question.trim(),
      expected: body.expected.trim(),
      expectedTools: body.tools,
      expectedAgents: body.agents,
      expectedScopes: body.scopes,
    };
    let id = addCase(reach.base, reach.auth, made);
    if (id == "") {
      return refusing("the trace backend refused the case");
    }
    return produced("{\"id\":" + JSON.stringify(id) + ",\"dataset\":" + JSON.stringify(dataset) + "}");
  }

  /** An edit is the whole case, not a patch: the backend takes the document
   *  wholesale, so a field left out of the body would be cleared rather than
   *  kept. The console sends what it loaded. */
  edit(id: string, sent: string): Outcome {
    if (id == "") {
      return refusing("name the case to change");
    }
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: EvalCaseBody = JSON.parse<EvalCaseBody>(sent);
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    let dataset = body.dataset.trim();
    if (dataset == "") {
      return refusing("name the set this case belongs to");
    }
    if (body.question.trim() == "") {
      return refusing("a case needs a question");
    }
    if (body.expected.trim() == "") {
      return refusing("a case needs the answer to compare against");
    }
    let made: NewCase = {
      dataset: dataset,
      question: body.question.trim(),
      expected: body.expected.trim(),
      expectedTools: body.tools,
      expectedAgents: body.agents,
      expectedScopes: body.scopes,
    };
    if (!updateCase(reach.base, reach.auth, id, made)) {
      return refusing("the trace backend refused the change");
    }
    return produced("{\"id\":" + JSON.stringify(id) + ",\"dataset\":" + JSON.stringify(dataset) + "}");
  }

  remove(id: string): Outcome {
    if (id == "") {
      return refusing("name the case to remove");
    }
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (!deleteCase(reach.base, reach.auth, id)) {
      return refusing("the trace backend refused to remove " + id);
    }
    return produced("{\"removed\":" + JSON.stringify(id) + "}");
  }

  /** Every past run of a set, newest first. A run is what the console shows as
   *  an execution: the same cases, put to an agent on a day, with the traces
   *  they left. */
  runs(dataset: string, limit: int): Outcome {
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (dataset.trim() == "") {
      return refusing("name the set of cases: ?dataset=linear-cycle");
    }
    let many = limit;
    if (many < 1 || many > 100) {
      many = 25;
    }
    return produced(JSON.stringify(datasetRuns(reach.base, reach.auth, dataset.trim(), many)));
  }

  ranCases(dataset: string, runName: string): Outcome {
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (dataset.trim() == "" || runName.trim() == "") {
      return refusing("name the set and the run");
    }
    return produced(JSON.stringify(runDetail(reach.base, reach.auth, dataset.trim(), runName.trim())));
  }

  /** What this one case has done, run after run. */
  caseHistory(dataset: string, itemId: string, limit: int): Outcome {
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (dataset.trim() == "" || itemId.trim() == "") {
      return refusing("name the eval and the case");
    }
    let many = limit;
    if (many < 1 || many > 25) {
      many = 10;
    }
    return produced(JSON.stringify(caseRuns(reach.base, reach.auth, dataset.trim(), itemId.trim(), many)));
  }

  run(sent: string, owner: string): Outcome {
    if (sent == "") {
      return refusing("a body is required");
    }
    let body: EvalRunBody = JSON.parse<EvalRunBody>(sent);
    let reach = this.reach();
    if (reach.fault != "") {
      return refusing(reach.fault);
    }
    if (body.agentId.trim() == "") {
      return refusing("name the agent to run the cases against");
    }
    if (body.dataset.trim() == "") {
      return refusing("name the set of cases to run");
    }
    let many = body.maxItems;
    if (many < 1 || many > MOST_RUN) {
      many = 5;
    }
    let runName = body.runName.trim();
    if (runName == "") {
      runName = "console-" + stamp();
    }
    let request: EvalRequest = {
      agentId: body.agentId.trim(),
      judgeAgentId: body.judgeAgentId.trim(),
      dataset: body.dataset.trim(),
      runName: runName,
      master: this.master,
      maxItems: many,
      onlyItem: body.onlyItem.trim(),
      owner: owner,
    };
    let run: EvalRun = runEvals(this.database, request, tracerFor(this.database, this.master));
    if (!run.ok) {
      return refusing(run.error);
    }
    return produced(JSON.stringify(run));
  }
}

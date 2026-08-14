import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, existsById, findById, listOrdered, persist, placeholderAt, setOn } from "../../../plume/plume.ts";
import { WfGraph } from "../../../workflow/workflow.ts";
import { graphSecretFault } from "../../secrets.ts";
import { enabledWorkflowCount } from "../../workflow-store.ts";
import { agentRepository } from "../agents/entities/agent.entity.ts";
import { workflowRunRepository } from "./entities/workflow-run.entity.ts";
import { workflowRepository } from "./entities/workflow.entity.ts";

export class WorkflowRepository {
  database: Db;
  workflows: DbRepository;
  runsOfWorkflows: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.workflows = workflowRepository();
    this.runsOfWorkflows = workflowRunRepository();
  }

  listing(owner: string): string {
    let keys: DbOrder[] = [{ column: "updated_at", direction: "desc" }];
    return listOrdered(this.database, this.workflows, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.workflows, id);
  }

  enabledCount(owner: string): int {
    return enabledWorkflowCount(this.database, owner);
  }

  hasAgent(id: string): bool {
    return existsById(this.database, agentRepository(), id);
  }

  secretFault(graph: WfGraph, owner: string): string {
    return graphSecretFault(this.database, graph, owner);
  }

  save(document: string): DbResult {
    return persist(this.database, this.workflows, document);
  }

  publish(id: string, graph: string, at: string): DbResult {
    return setOn(this.database, this.workflows, {
      id: id,
      values: [
        { column: "published_graph", value: graph },
        { column: "published_at", value: at },
        { column: "updated_at", value: at },
      ],
    });
  }

  markRunNow(id: string, at: string): DbResult {
    return setOn(this.database, this.workflows, {
      id: id,
      values: [
        { column: "next_at", value: at },
        { column: "running_since", value: "" },
        { column: "enabled", value: "true" },
        { column: "updated_at", value: at },
      ],
    });
  }

  runs(workflowId: string, owner: string): string {
    let keys: DbOrder[] = [{ column: "started_at", direction: "desc" }];
    return listOrdered(this.database, this.runsOfWorkflows, {
      where: "workflow_id = " + this.database.placeholder + " AND owner = " + placeholderAt(this.database, 2),
      args: [workflowId, owner],
      order: keys,
    });
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      deleteWhere(this.database, this.runsOfWorkflows, "workflow_id = " + this.database.placeholder, [id]),
      deleteById(this.database, this.workflows, id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}

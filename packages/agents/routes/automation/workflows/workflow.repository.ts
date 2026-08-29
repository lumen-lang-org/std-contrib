import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, executeWith, existsById, findById, listOrdered, persist, persistIfBelowCount, placeholderAt, setOn } from "../../../../plume/plume.ts";
import { WfGraph } from "../../../../workflow/workflow.ts";
import { RUN_TIMEOUT_MS } from "../../../tasks.ts";
import { agentRepository } from "../../authoring/agents/entities/agent.entity.ts";
import { SecretRepository } from "../../identity/secrets/secret.repository.ts";
import { workflowRunRepository } from "./entities/workflow-run.entity.ts";
import { workflowRepository } from "./entities/workflow.entity.ts";

export class WorkflowRepository {
  database: Db;
  workflows: DbRepository;
  runsOfWorkflows: DbRepository;
  secrets: SecretRepository;

  constructor(database: Db) {
    this.database = database;
    this.workflows = workflowRepository();
    this.runsOfWorkflows = workflowRunRepository();
    this.secrets = new SecretRepository(database);
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

  /** How many of this owner's workflows are running, or -1 when that cannot
   *  be counted: a query that did not run answered 0 here, and 0 is the one
   *  answer that lets the cap through. */
  enabledCount(owner: string): int {
    let sql = "SELECT COUNT(*) FROM workflows WHERE owner = " + this.database.placeholder + " AND enabled = true";
    if (!this.database.query(sql, [owner])) {
      return -1;
    }
    if (this.database.rows() == 0) {
      return -1;
    }
    return parseInt(this.database.value(0, 0)) ?? -1;
  }

  hasAgent(id: string): bool {
    return existsById(this.database, agentRepository(), id);
  }

  secretFault(graph: WfGraph, owner: string): string {
    return this.secrets.graphFault(graph, owner);
  }

  save(document: string): DbResult {
    return persist(this.database, this.workflows, document);
  }

  saveIfUnderCap(document: string, owner: string, cap: int): DbResult {
    let countSql = "SELECT COUNT(*) FROM workflows WHERE owner = "
      + placeholderAt(this.database, 2) + " AND enabled = true";
    return persistIfBelowCount(this.database, this.workflows, document, countSql, [owner], cap);
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
    let atMs = parseFloat(at) ?? 0.0;
    let stale = `${(atMs as i64) - (RUN_TIMEOUT_MS as i64)}`;
    let sql = "UPDATE workflows SET next_at = " + this.database.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(this.database, 2)
      + " WHERE id = " + placeholderAt(this.database, 3)
      + " AND (running_since = '' OR running_since < " + placeholderAt(this.database, 4) + ")"
      + " RETURNING id";
    return executeWith(this.database, sql, [at, at, id, stale]);
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

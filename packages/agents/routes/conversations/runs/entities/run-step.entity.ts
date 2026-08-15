import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("run_steps")
export class RunStep {
  @Id
  @Column("id", "text")
  id: string;

  @Column("run_id", "text")
  runId: string;

  @Column("step_index", "int")
  stepIndex: int;

  @Column("tool", "text")
  tool: string;

  @Column("server", "text")
  server: string;

  @Column("args", "text")
  args: string;

  @Column("result", "text")
  result: string;

  @Column("ok", "bool")
  ok: bool;

  constructor(id: string, runId: string, stepIndex: int, tool: string, server: string,
              args: string, result: string, ok: bool) {
    this.id = id;
    this.runId = runId;
    this.stepIndex = stepIndex;
    this.tool = tool;
    this.server = server;
    this.args = args;
    this.result = result;
    this.ok = ok;
  }
}

export function runStepRepository(): DbRepository {
  return entityRunStep;
}

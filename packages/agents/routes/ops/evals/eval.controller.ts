import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, answered } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { EvalService } from "./eval.service.ts";

@controller("/evals")
@bindings
export class EvalApi {
  evals: EvalService;

  constructor(database: Db, master: string) {
    this.evals = new EvalService(database, master);
  }

  @Get("/datasets")
  datasets(): Reply {
    return answered(this.evals.datasets());
  }

  @Post("/datasets")
  addDataset(@RequestBody body: string): Reply {
    return answered(this.evals.addDataset(body));
  }

  @Get("/cases")
  cases(@RequestParam("dataset", "") dataset: string,
        @RequestParam("limit", "200") limit: string): Reply {
    return answered(this.evals.cases(dataset, parseInt(limit, 10) ?? 200));
  }

  @Post("/cases")
  addCase(@RequestBody body: string): Reply {
    return answered(this.evals.addOne(body));
  }

  @Get("/cases/:id/runs")
  caseRuns(@PathVariable("id") id: string,
           @RequestParam("dataset", "") dataset: string,
           @RequestParam("limit", "10") limit: string): Reply {
    return answered(this.evals.caseHistory(dataset, id, parseInt(limit, 10) ?? 10));
  }

  @Put("/cases/:id")
  editCase(@PathVariable("id") id: string, @RequestBody body: string): Reply {
    return answered(this.evals.edit(id, body));
  }

  @Delete("/cases/:id")
  dropCase(@PathVariable("id") id: string): Reply {
    return answered(this.evals.remove(id));
  }

  @Get("/runs")
  runs(@RequestParam("dataset", "") dataset: string,
       @RequestParam("limit", "25") limit: string): Reply {
    return answered(this.evals.runs(dataset, parseInt(limit, 10) ?? 25));
  }

  @Get("/runs/:name")
  ranCases(@PathVariable("name") name: string,
           @RequestParam("dataset", "") dataset: string): Reply {
    return answered(this.evals.ranCases(dataset, name));
  }

  /* Answers when the last case has been judged, which is one agent run per
     case and slow by nature. The caller sets how many it is willing to wait
     for; the service caps it. */
  @Post("/runs")
  run(@RequestBody body: string, @From(owningCaller) owner: string): Reply {
    return answered(this.evals.run(body, owner));
  }
}

import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, OkJson, Reply } from "../../../rest/server.ts";
import { jobsNeedPostgres } from "./job.guard.ts";
import { JobService } from "./job.service.ts";

@controller("/jobs")
@bindings
export class JobApi {
  jobs: JobService;

  constructor(database: Db) {
    this.jobs = new JobService(database);
  }

  needsPg(): Guarded {
    return jobsNeedPostgres(this.jobs);
  }

  @Get("/")
  @Guard(needsPg)
  list(): Reply {
    return OkJson(this.jobs.pending());
  }
}

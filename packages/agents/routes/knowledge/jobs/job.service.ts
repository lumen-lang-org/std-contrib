import { Db } from "../../../../plume/driver.ts";
import { JobView } from "./dtos/job-view.dto.ts";
import { JobRepository } from "./job.repository.ts";
import { jobViewOf } from "./job.utils.ts";

export class JobService {
  repository: JobRepository;

  constructor(database: Db) {
    this.repository = new JobRepository(database);
  }

  pending(owner: string): JobView[] {
    return this.repository.pending(owner, "").map(jobViewOf);
  }
}

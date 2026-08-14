import { IndexJobRow } from "./entities/index-job.entity.ts";
import { JobView } from "./dtos/job-view.dto.ts";

export function jobViewOf(row: IndexJobRow): JobView {
  let out: JobView = {
    id: row.id,
    source: row.source,
    scope: row.scope,
    status: row.status,
    chunks: row.chunks,
    error: row.error,
    createdAt: row.createdAt,
  };
  return out;
}

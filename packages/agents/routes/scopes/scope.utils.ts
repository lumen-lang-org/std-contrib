import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";

export function scopeNamesOf(rows: IndexJobRow[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < rows.length) {
    out.push(rows[i].scope);
    i = i + 1;
  }
  return out;
}

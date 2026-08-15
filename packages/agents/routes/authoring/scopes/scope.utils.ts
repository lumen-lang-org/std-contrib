import { IndexJobRow } from "../../knowledge/jobs/entities/index-job.entity.ts";
import { normalScope } from "../../../knowledge.ts";

export type ScopeNode = {
  path: string,
  documents: int,
  total: int,
};

export function scopeCovers(granted: string, path: string): bool {
  let g = normalScope(granted);
  let p = normalScope(path);
  if (g == "/") {
    return true;
  }
  if (p == g) {
    return true;
  }
  return p.startsWith(g + "/");
}

export function scopeNamesOf(rows: IndexJobRow[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < rows.length) {
    out.push(rows[i].scope);
    i = i + 1;
  }
  return out;
}

import { Db } from "../../../plume/driver.ts";
import { JobRepository } from "../jobs/job.repository.ts";
import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";
import { ScopeNode, scopeCovers } from "./scope.utils.ts";

function pendingIn(pending: string[], scope: string): int {
  let n: int = 0;
  let i: int = 0;
  while (i < pending.length) {
    if (pending[i] == scope) {
      n = n + 1;
    }
    i = i + 1;
  }
  return n;
}

export class ScopeRepository {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  pending(): IndexJobRow[] {
    return new JobRepository(this.database).pending("");
  }

  counts(prefix: string, pendingScopes: string[]): ScopeNode[] {
    let out: ScopeNode[] = [];
    let sql = "SELECT scope, COUNT(*) FROM documents GROUP BY scope ORDER BY scope";
    if (!this.database.query(sql, [])) {
      return out;
    }

    let paths: string[] = [];
    let counts: int[] = [];
    let i: int = 0;
    while (i < this.database.rows()) {
      paths.push(this.database.value(i, 0));
      counts.push(parseInt(this.database.value(i, 1)) ?? 0);
      i = i + 1;
    }

    let n: int = 0;
    while (n < pendingScopes.length) {
      let seen = false;
      let s: int = 0;
      while (s < paths.length) {
        if (paths[s] == pendingScopes[n]) {
          seen = true;
        }
        s = s + 1;
      }
      if (!seen) {
        paths.push(pendingScopes[n]);
        counts.push(0);
      }
      n = n + 1;
    }

    let p: int = 0;
    while (p < paths.length) {
      if (prefix == "" || scopeCovers(prefix, paths[p])) {
        let total: int = 0;
        let q: int = 0;
        while (q < paths.length) {
          if (scopeCovers(paths[p], paths[q])) {
            total = total + counts[q] + pendingIn(pendingScopes, paths[q]);
          }
          q = q + 1;
        }
        let node: ScopeNode = {
          path: paths[p],
          documents: counts[p] + pendingIn(pendingScopes, paths[p]),
          total: total,
        };
        out.push(node);
      }
      p = p + 1;
    }
    return out;
  }
}

import { Db } from "../../../../plume/driver.ts";
import { scopesJson } from "../../../payload.ts";
import { ScopeRepository } from "./scope.repository.ts";
import { scopeNamesOf } from "./scope.utils.ts";

export class ScopeService {
  repository: ScopeRepository;

  constructor(database: Db) {
    this.repository = new ScopeRepository(database);
  }

  tree(owner: string, prefix: string): string {
    let pending = scopeNamesOf(this.repository.pending(owner));
    return scopesJson(this.repository.counts(owner, prefix, pending));
  }
}

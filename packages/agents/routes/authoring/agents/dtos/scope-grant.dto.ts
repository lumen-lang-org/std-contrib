import { Rule, validated, Required } from "../../../../../validation/validation.ts";

@validated
export class ScopeGrant {
  @Required("a scope is required")
  scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }
}

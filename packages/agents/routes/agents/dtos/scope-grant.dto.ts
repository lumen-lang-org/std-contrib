import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class ScopeGrant {
  @required("a scope is required")
  scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }
}

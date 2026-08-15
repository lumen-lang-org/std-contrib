import { Rule, validated, Required } from "../../../../../validation/validation.ts";
import { OpenApiField, schema } from "../../../../../openapi/openapi.ts";

@validated
@schema
export class ScopeGrant {
  @Required("a scope is required")
  scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }
}

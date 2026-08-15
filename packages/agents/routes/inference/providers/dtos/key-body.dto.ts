import { Rule, validated, Required } from "../../../../../validation/validation.ts";

@validated
export class KeyBody {
  @Required("an empty key is not a credential")
  apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
}

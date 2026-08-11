import { Rule, validated, Required } from "../../../../validation/validation.ts";

@validated
export class AuthProviderSecretAsk {
  @Required("a client secret is required")
  clientSecret: string;

  constructor(clientSecret: string) {
    this.clientSecret = clientSecret;
  }
}

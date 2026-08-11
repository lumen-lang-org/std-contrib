import { validated, Rule } from "../../../../validation/validation.ts";

@validated
export class AuthProviderSecretAsk {
  @required("a client secret is required")
  clientSecret: string;

  constructor(clientSecret: string) {
    this.clientSecret = clientSecret;
  }
}

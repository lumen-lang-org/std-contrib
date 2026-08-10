import { validated, Rule } from "../../../validation/validation.ts";

@validated
export class KeyBody {
  @required("an empty key is not a credential")
  apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
}

export type ProviderStatus = { provider: string, configured: bool };

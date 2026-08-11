import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { jsonText } from "../../scan.ts";
import { MintedKey } from "./dtos/minted-key.dto.ts";
import { ApiKeyRepository } from "./api-key.repository.ts";

export class ApiKeyService {
  repository: ApiKeyRepository;

  constructor(database: Db) {
    this.repository = new ApiKeyRepository(database);
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  create(owner: string, body: string): Outcome {
    let made = this.repository.mint(owner, jsonText(body, "name"), jsonText(body, "scopes"), stamp());
    if (made.fault != "") {
      return refusing(made.fault);
    }
    let minted: MintedKey = { id: made.id, secret: made.secret, keyPrefix: made.prefix };
    return produced(JSON.stringify(minted));
  }

  forget(id: string, owner: string): bool {
    return this.repository.forget(id, owner);
  }
}

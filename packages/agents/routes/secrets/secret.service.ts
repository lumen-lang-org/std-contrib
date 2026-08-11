import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { jsonText } from "../../scan.ts";
import { SecretRepository } from "./secret.repository.ts";

export class SecretService {
  repository: SecretRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new SecretRepository(database);
    this.master = master;
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  create(owner: string, body: string): Outcome {
    let made = this.repository.create({
      owner: owner,
      name: jsonText(body, "name"),
      value: jsonText(body, "value"),
      destination: jsonText(body, "destination"),
      header: jsonText(body, "header"),
      category: jsonText(body, "category"),
      master: this.master,
      now: stamp(),
    });
    if (made.fault != "") {
      return refusing(made.fault);
    }
    return produced(this.repository.one(made.id));
  }

  forget(id: string, owner: string): bool {
    return this.repository.forget(id, owner);
  }
}

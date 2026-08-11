import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { jsonText } from "../../scan.ts";
import { EnvKeyRepository } from "./env-key.repository.ts";

export class EnvKeyService {
  repository: EnvKeyRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new EnvKeyRepository(database);
    this.master = master;
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  create(owner: string, body: string): Outcome {
    let imageId = jsonText(body, "imageId");
    if (!this.repository.imageKnown(imageId, owner)) {
      return refusing("no environment has the id \"" + imageId + "\" — one of yours, one this deployment offers, or \"default\" for the one an agent gets when nobody chose");
    }
    let made = this.repository.create({
      owner: owner,
      imageId: imageId,
      name: jsonText(body, "name"),
      value: jsonText(body, "value"),
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

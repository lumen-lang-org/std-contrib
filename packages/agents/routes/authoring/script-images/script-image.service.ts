import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { createFault, jsonId } from "../../../payload.ts";
import { ScriptImageBody } from "./dtos/script-image-body.dto.ts";
import { ScriptImageRepository } from "./script-image.repository.ts";
import { scriptImageFault } from "./script-image.utils.ts";

export class ScriptImageService {
  repository: ScriptImageRepository;

  constructor(database: Db) {
    this.repository = new ScriptImageRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  create(document: string): Outcome {
    let fault = createFault(this.repository.database, this.repository.images, document);
    if (fault != "") {
      return refusing(fault);
    }
    let row: ScriptImageBody = JSON.parse<ScriptImageBody>(document);
    let named = scriptImageFault(row);
    if (named != "") {
      return refusing(named);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(jsonId(document)));
  }

  update(id: string, document: string): Outcome {
    let row: ScriptImageBody = JSON.parse<ScriptImageBody>(document);
    if (row.id != id) {
      return refusing("the id in the body must match the path");
    }
    let named = scriptImageFault(row);
    if (named != "") {
      return refusing(named);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  forget(id: string): Outcome {
    let fault = this.repository.forget(id);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }
}

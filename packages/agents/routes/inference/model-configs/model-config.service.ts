import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { bodyText } from "../../../api-core.ts";
import { jsonId } from "../../../payload.ts";
import { ModelConfigBody } from "./dtos/model-config-body.dto.ts";
import { ModelConfigRepository } from "./model-config.repository.ts";
import { configFault, mergedConfig } from "./model-config.utils.ts";

export class ModelConfigService {
  repository: ModelConfigRepository;

  constructor(database: Db) {
    this.repository = new ModelConfigRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  one(id: string): string {
    return this.repository.one(id);
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  create(document: string): Outcome {
    let fault = this.repository.creationFault(document);
    if (fault != "") {
      return refusing(fault);
    }
    let row: ModelConfigBody = JSON.parse<ModelConfigBody>(document);
    let wrong = configFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(jsonId(document)));
  }

  update(id: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    if (bodyText(document, "id", id) != id) {
      return refusing("the id in the body must match the path");
    }
    let stored = this.repository.storedRow(id);
    let row = mergedConfig(JSON.parse<ModelConfigBody>(stored), document);
    let wrong = configFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  /** Why a config cannot be deleted yet, named so the reader knows what to
   *  repoint first. */
  inUse(id: string): string {
    if (this.repository.agentsOn(id) > 0) {
      return "config " + id + " is used by an agent; repoint it first";
    }
    if (this.repository.menuRowsOn(id) > 0) {
      return "config " + id + " is a row of the model menu; take the choice off the menu first";
    }
    if (this.repository.routersOn(id) > 0) {
      return "config " + id + " is a router's own config or its fallback; repoint the router first";
    }
    return "";
  }

  forget(id: string): Outcome {
    let used = this.inUse(id);
    if (used != "") {
      return refusing(used);
    }
    let gone = this.repository.remove(id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }
}

import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { bodyText } from "../../../api-core.ts";
import { jsonId } from "../../../payload.ts";
import { ModelRouterBody } from "./dtos/model-router-body.dto.ts";
import { ModelRouterRepository } from "./model-router.repository.ts";
import { blankRouter, mergedRouter, preEncodedCandidates, routerJson, routerRowFault, routersJson, withCanonicalCandidates } from "./model-router.utils.ts";

export class ModelRouterService {
  repository: ModelRouterRepository;

  constructor(database: Db) {
    this.repository = new ModelRouterRepository(database);
  }

  listing(): string {
    return routersJson(this.repository.all());
  }

  one(id: string): string {
    return routerJson(JSON.parse<ModelRouterBody>(this.repository.one(id)));
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  create(document: string): Outcome {
    let fault = this.repository.creationFault(document);
    if (fault != "") {
      return refusing(fault);
    }
    let blob = preEncodedCandidates(document);
    if (blob != "") {
      return refusing(blob);
    }
    let row = mergedRouter(blankRouter(jsonId(document)), document);
    let wrong = routerRowFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.one(row.id));
  }

  update(id: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    if (bodyText(document, "id", id) != id) {
      return refusing("the id in the body must match the path");
    }
    let blob = preEncodedCandidates(document);
    if (blob != "") {
      return refusing(blob);
    }
    let stored = this.repository.one(id);
    let row = mergedRouter(JSON.parse<ModelRouterBody>(stored), document);
    let wrong = routerRowFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(JSON.stringify(withCanonicalCandidates(row)));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.one(id));
  }

  /** A router a menu choice points at cannot go: the menu would name something
   *  that is not there. */
  inUse(id: string): string {
    let onChoices = this.repository.choicesOn(id);
    if (onChoices < 0) {
      return "could not check whether router " + id + " is still in use";
    }
    if (onChoices > 0) {
      return "router " + id + " is what a menu choice points at; delete or "
        + "repoint that choice first";
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

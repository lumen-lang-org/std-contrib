import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { bodyText } from "../../../api-core.ts";
import { jsonId } from "../../../payload.ts";
import { ModelChoiceBody } from "./dtos/model-choice-body.dto.ts";
import { ModelChoiceRepository } from "./model-choice.repository.ts";
import { blankChoice, choiceRowFault, mergedChoice } from "./model-choice.utils.ts";

export class ModelChoiceService {
  repository: ModelChoiceRepository;

  constructor(database: Db) {
    this.repository = new ModelChoiceRepository(database);
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
    let row = mergedChoice(blankChoice(jsonId(document)), document);
    let wrong = choiceRowFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(row.id));
  }

  update(id: string, document: string): Outcome {
    if (document == "") {
      return refusing("a body is required");
    }
    if (bodyText(document, "id", id) != id) {
      return refusing("the id in the body must match the path");
    }
    let stored = this.repository.one(id);
    let row = mergedChoice(JSON.parse<ModelChoiceBody>(stored), document);
    let wrong = choiceRowFault(this.repository.database, row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  /** Taking a choice off the menu is not the same as deleting it: the
   *  conversations already set to it would lose what they were answering on. */
  inUse(id: string): string {
    let onThreads = this.repository.threadsOn(id);
    if (onThreads < 0) {
      return "could not check whether model choice " + id + " is still in use";
    }
    if (onThreads > 0) {
      return "model choice " + id + " is what conversations are still set to; "
        + "take it off the menu instead — PUT /model-choices/" + id
        + " with {\"enabled\":false} leaves those conversations running";
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

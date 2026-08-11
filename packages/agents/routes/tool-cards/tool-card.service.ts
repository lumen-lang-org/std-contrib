import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { toolCardFault } from "../../api-core.ts";
import { ToolCardRow } from "../../toolcards.ts";
import { ToolCardRepository } from "./tool-card.repository.ts";

export class ToolCardService {
  repository: ToolCardRepository;

  constructor(database: Db) {
    this.repository = new ToolCardRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  add(body: string): Outcome {
    if (body == "") {
      return refusing("a body is required");
    }
    let row: ToolCardRow = JSON.parse<ToolCardRow>(body);
    let fault = toolCardFault(row);
    if (fault != "") {
      return refusing(fault);
    }
    if (this.repository.exists(row.id)) {
      return refusing("tool card " + row.id + " already exists; PUT it to change it");
    }
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(JSON.stringify(row));
  }

  change(id: string, body: string): Outcome {
    let row: ToolCardRow = JSON.parse<ToolCardRow>(body);
    let fault = toolCardFault(row);
    if (fault != "") {
      return refusing(fault);
    }
    if (row.id != id) {
      return refusing("the body's id must match the path");
    }
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(JSON.stringify(row));
  }

  forget(id: string): Outcome {
    let gone = this.repository.forget(id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }
}

import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { DestinationMove, credentialFor, destinationFault, hasCredential } from "../../credentials.ts";
import { complete, embedText, replyText } from "../../provider.ts";
import { ChatProbe } from "./dtos/chat-probe.dto.ts";
import { EmbeddingProbe } from "./dtos/embedding-probe.dto.ts";
import { ModelAsk } from "./dtos/model-ask.dto.ts";
import { ModelTestFailed } from "./dtos/model-test-failed.dto.ts";
import { StoredModel } from "./dtos/stored-model.dto.ts";
import { ModelRepository } from "./model.repository.ts";
import { authorisedModel, choicesJson, modelDestination, modelFault, probeConfig, probeModel, storedModelOf } from "./model.utils.ts";

export class ModelService {
  repository: ModelRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.repository = new ModelRepository(database);
    this.master = master;
  }

  listing(): string {
    return this.repository.listing();
  }

  choices(): string {
    return choicesJson(this.repository.choices());
  }

  one(id: string): string {
    return this.repository.one(id);
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  movedFault(row: StoredModel): string {
    let held = this.repository.one(row.id);
    let authorised = authorisedModel(row);
    if (held != "") {
      authorised = JSON.parse<StoredModel>(held);
    }
    let move: DestinationMove = {
      subject: "model " + row.id,
      secretName: "the " + row.provider + " key",
      clearWith: "DELETE /providers/" + row.provider + "/key",
      was: modelDestination(authorised),
      now: modelDestination(row),
      secretStored: hasCredential(this.repository.database, row.provider),
    };
    return destinationFault(move);
  }

  create(ask: ModelAsk): Outcome {
    let document = JSON.stringify(ask);
    let fault = this.repository.creationFault(document);
    if (fault != "") {
      return refusing(fault);
    }
    let row = storedModelOf(ask);
    let wrong = modelFault(row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let moved = this.movedFault(row);
    if (moved != "") {
      return refusing(moved);
    }
    if (row.enabled && row.kind == "embedding") {
      let swept = this.repository.disableOtherEmbeddings(row.id);
      if (!swept.ok) {
        return refusing(swept.error);
      }
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(row.id));
  }

  update(id: string, ask: ModelAsk): Outcome {
    let row = storedModelOf(ask);
    if (row.id != id) {
      return refusing("the id in the body must match the path");
    }
    let wrong = modelFault(row);
    if (wrong != "") {
      return refusing(wrong);
    }
    let moved = this.movedFault(row);
    if (moved != "") {
      return refusing(moved);
    }
    if (row.enabled && row.kind == "embedding") {
      let swept = this.repository.disableOtherEmbeddings(id);
      if (!swept.ok) {
        return refusing(swept.error);
      }
    }
    let written = this.repository.save(JSON.stringify(ask));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  test(id: string): Outcome {
    let stored: StoredModel = JSON.parse<StoredModel>(this.repository.one(id));
    let key = credentialFor(this.repository.database, stored.provider, this.master);
    if (key == "") {
      return refusing("no credential stored for " + stored.provider);
    }

    let model = probeModel(stored);

    if (model.kind == "embedding") {
      let vector = embedText(model, "a probe from the console", key);
      if (!vector.ok) {
        let failed: ModelTestFailed = { ok: false, error: vector.error };
        return produced(JSON.stringify(failed));
      }
      let agrees = vector.dimensions == model.dimensions;
      let probe: EmbeddingProbe = {
        ok: agrees,
        dimensions: vector.dimensions,
        declared: model.dimensions,
        error: agrees ? "" : "the model returned a different width than this row declares",
      };
      return produced(JSON.stringify(probe));
    }

    let config = probeConfig(model.id);
    let said = complete(model, config, "Reply with the single word: ok", "ping", key);
    if (!said.ok) {
      let failed: ModelTestFailed = { ok: false, error: said.error };
      return produced(JSON.stringify(failed));
    }
    let answer = replyText(model.provider, said.text);
    let probe: ChatProbe = {
      ok: true,
      reply: answer.slice(0, 120),
      inputTokens: said.inputTokens,
      outputTokens: said.outputTokens,
    };
    return produced(JSON.stringify(probe));
  }

  forget(id: string): Outcome {
    if (this.repository.configsUsing(id) > 0) {
      return refusing("model " + id + " is used by a model config; delete or repoint those first");
    }
    let gone = this.repository.forget(id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }
}

export function modelDestinationFault(database: Db, row: StoredModel): string {
  return new ModelService(database, "").movedFault(row);
}

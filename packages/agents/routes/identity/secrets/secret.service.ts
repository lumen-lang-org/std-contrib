import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { jsonText } from "../../../scan.ts";
import { credentialFor, forgetCredential, storeCredential } from "../../../credentials.ts";
import { SecretRepository } from "./secret.repository.ts";
import { MAX_SECRETS_PER_OWNER, MAX_SECRET_NAME, MAX_SECRET_VALUE, SecretMade, SecretRow, SecretWrite, originOf, secretRef } from "./secret.utils.ts";

export class SecretService {
  database: Db;
  repository: SecretRepository;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.repository = new SecretRepository(database);
    this.master = master;
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  refuse(row: SecretRow): string {
    if (row.name.trim() == "") {
      return "a secret needs a name to be picked by";
    }
    if (row.name.length > MAX_SECRET_NAME) {
      return "\"" + row.name.slice(0, 20) + "...\" is too long a name";
    }
    if (row.owner == "") {
      return "a secret has to belong to somebody";
    }
    let header = row.header.trim();
    if (header == "" || header.indexOf(" ") >= 0 || header.indexOf(":") >= 0) {
      return "\"" + row.header + "\" is not a header name — one word, like \"Authorization\" or \"X-Api-Key\"";
    }
    if (originOf(row.destination) != row.destination || row.destination == "") {
      return "a secret needs the address it may be sent to, as an origin — like \"https://api.stripe.com\"";
    }
    return "";
  }

  mint(ask: SecretWrite): SecretMade {
    let row: SecretRow = {
      id: crypto.randomUUID(),
      owner: ask.owner,
      name: ask.name.trim(),
      header: ask.header.trim() == "" ? "Authorization" : ask.header.trim(),
      destination: originOf(ask.destination),
      category: ask.category.trim(),
      createdAt: ask.now,
      lastUsedAt: "",
    };
    let wrong = this.refuse(row);
    if (wrong != "") {
      return { id: "", fault: wrong };
    }
    if (ask.value.length > MAX_SECRET_VALUE) {
      return {
        id: "",
        fault: "that value is " + `${ask.value.length}` + " characters — the most a secret may hold is " + `${MAX_SECRET_VALUE}`,
      };
    }
    if (this.repository.byName(row.name, ask.owner).id != "") {
      return {
        id: "",
        fault: "there is already a secret called \"" + row.name + "\" — delete it first, or pick another name",
      };
    }
    if (JSON.parse<SecretRow[]>(this.repository.listing(ask.owner)).length >= MAX_SECRETS_PER_OWNER) {
      return {
        id: "",
        fault: "that is " + `${MAX_SECRETS_PER_OWNER}` + " secrets already — delete one before adding another",
      };
    }
    let stored = storeCredential(this.database, {
      provider: secretRef(row.id), apiKey: ask.value, masterKey: ask.master, now: ask.now,
    });
    if (stored != "") {
      return { id: "", fault: stored };
    }
    let written = this.repository.save(row);
    if (!written.ok) {
      forgetCredential(this.database, secretRef(row.id));
      return { id: "", fault: written.error };
    }
    return { id: row.id, fault: "" };
  }

  create(owner: string, body: string): Outcome {
    let made = this.mint({
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
    let row = this.repository.byId(id, owner);
    if (row.id == "") {
      return false;
    }
    let droppedRow = this.repository.remove(id).ok;
    let droppedValue = forgetCredential(this.database, secretRef(id));
    return droppedRow && droppedValue;
  }

  value(row: SecretRow): string {
    return credentialFor(this.database, secretRef(row.id), this.master);
  }

  touch(id: string, now: string): void {
    this.repository.touch(id, now);
  }
}

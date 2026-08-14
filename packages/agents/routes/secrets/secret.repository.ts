import { Db } from "../../../plume/driver.ts";
import { DbAssignment, DbOrder, DbRepository, DbResult, deleteById, findById, listOrdered, persist, setOn } from "../../../plume/plume.ts";
import { WfGraph, secretIds } from "../../../workflow/workflow.ts";
import { secretRepository } from "./entities/secret.entity.ts";
import { SecretRow, emptySecret, originOf } from "./secret.utils.ts";

export class SecretRepository {
  database: Db;
  secrets: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.secrets = secretRepository();
  }

  listing(owner: string): string {
    let keys: DbOrder[] = [{ column: "name" }];
    return listOrdered(this.database, this.secrets, {
      where: "owner = " + this.database.placeholder,
      args: [owner],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.secrets, id);
  }

  byId(id: string, owner: string): SecretRow {
    let doc = this.one(id);
    if (doc == "") {
      return emptySecret();
    }
    let row: SecretRow = JSON.parse<SecretRow>(doc);
    if (row.owner != owner) {
      return emptySecret();
    }
    return row;
  }

  byName(name: string, owner: string): SecretRow {
    let rows = JSON.parse<SecretRow[]>(this.listing(owner));
    let i: int = 0;
    while (i < rows.length) {
      if (rows[i].name.toLowerCase() == name.trim().toLowerCase()) {
        return rows[i];
      }
      i = i + 1;
    }
    return emptySecret();
  }

  save(row: SecretRow): DbResult {
    return persist(this.database, this.secrets, JSON.stringify(row));
  }

  remove(id: string): DbResult {
    return deleteById(this.database, this.secrets, id);
  }

  touch(id: string, now: string): void {
    let values: DbAssignment[] = [{ column: "last_used_at", value: now }];
    setOn(this.database, this.secrets, { id: id, values: values });
  }

  graphFault(graph: WfGraph, owner: string): string {
    let i: int = 0;
    while (i < graph.nodes.length) {
      let node = graph.nodes[i];
      let label = node.name == "" ? node.id : node.name;
      let held = secretIds(node);
      let s: int = 0;
      while (s < held.length) {
        let row = this.byId(held[s], owner);
        if (row.id == "") {
          return label + " names a secret that is not here — list_secrets says which exist, or pick one in the step's settings";
        }
        if (node.url.trim() != "") {
          let to = originOf(node.url);
          if (to != row.destination) {
            return label + " sends to " + (to == "" ? "an address this cannot read" : to)
              + ", and \"" + row.name + "\" was stored for " + row.destination
              + " — a secret is only sent to the address it was stored for."
              + " Delete the secret and add it again if the address has moved.";
          }
        }
        s = s + 1;
      }
      i = i + 1;
    }
    return "";
  }
}

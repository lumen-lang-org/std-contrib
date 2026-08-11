import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, existsById, findById, linkOf, listOrdered, persist, unlinkAllPointingAt, setOn } from "../../../plume/plume.ts";
import { createFault } from "../../payload.ts";
import { agentRepository } from "../agents/entities/agent.entity.ts";
import { mcpServerRepository } from "./entities/mcp-server.entity.ts";

export class ServerRepository {
  database: Db;
  servers: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.servers = mcpServerRepository();
  }

  listing(): string {
    let keys: DbOrder[] = [{ column: "server_name" }];
    return listOrdered(this.database, this.servers, { order: keys });
  }

  one(id: string): string {
    return findById(this.database, this.servers, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.servers, id);
  }

  creationFault(document: string): string {
    return createFault(this.database, this.servers, document);
  }

  setAuth(id: string, authKind: string, authHeader: string): DbResult {
    return setOn(this.database, this.servers, {
      id: id,
      values: [
        { column: "auth_kind", value: authKind },
        { column: "auth_header", value: authHeader },
      ],
    });
  }

  save(document: string): DbResult {
    return persist(this.database, this.servers, document);
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      unlinkAllPointingAt(this.database, linkOf(agentRepository(), "servers"), id),
      deleteById(this.database, this.servers, id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}

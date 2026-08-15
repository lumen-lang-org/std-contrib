import { Db } from "../../../../plume/driver.ts";
import { DbRepository, existsById, findById } from "../../../../plume/plume.ts";
import { mcpServerRepository } from "../servers/entities/mcp-server.entity.ts";

export class ConnectRepository {
  database: Db;
  servers: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.servers = mcpServerRepository();
  }

  one(id: string): string {
    return findById(this.database, this.servers, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.servers, id);
  }
}

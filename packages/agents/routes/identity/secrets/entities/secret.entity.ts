import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("secrets")
export class Secret {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("name", "text")
  name: string;

  @Column("header", "text")
  header: string;

  @Column("destination", "text")
  destination: string;

  @Column("category", "text")
  category: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("last_used_at", "text")
  lastUsedAt: string;

  constructor(id: string, owner: string, name: string, header: string, destination: string, category: string, createdAt: string, lastUsedAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.header = header;
    this.destination = destination;
    this.category = category;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
  }
}

export function secretRepository(): DbRepository {
  return entitySecret;
}

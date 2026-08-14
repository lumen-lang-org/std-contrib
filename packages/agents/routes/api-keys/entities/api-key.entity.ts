import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("api_keys")
export class ApiKey {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("name", "text")
  name: string;

  @Column("key_prefix", "text")
  keyPrefix: string;

  @Column("key_hash", "text")
  keyHash: string;

  @Column("scopes", "text")
  scopes: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("last_used_at", "text")
  lastUsedAt: string;

  constructor(id: string, owner: string, name: string, keyPrefix: string, keyHash: string, scopes: string, createdAt: string, lastUsedAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.keyPrefix = keyPrefix;
    this.keyHash = keyHash;
    this.scopes = scopes;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
  }
}

export function apiKeyRepository(): DbRepository {
  return entityApiKey;
}

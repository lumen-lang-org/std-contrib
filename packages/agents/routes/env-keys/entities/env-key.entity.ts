import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("env_keys")
export class EnvKey {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("image_id", "text")
  imageId: string;

  @Column("name", "text")
  name: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("last_used_at", "text")
  lastUsedAt: string;

  constructor(id: string, owner: string, imageId: string, name: string, createdAt: string, lastUsedAt: string) {
    this.id = id;
    this.owner = owner;
    this.imageId = imageId;
    this.name = name;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
  }
}

export function envKeyRepository(): DbRepository {
  return entityEnvKey;
}

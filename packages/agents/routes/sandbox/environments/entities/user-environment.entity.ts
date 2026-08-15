import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("user_environments")
export class UserEnvironment {
  @Id
  @Column("id", "text")
  id: string;

  @Column("owner", "text")
  owner: string;

  @Column("name", "text")
  name: string;

  @Column("image", "text")
  image: string;

  @Column("source", "text")
  source: string;

  @Column("dockerfile", "text")
  dockerfile: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, owner: string, name: string, image: string, source: string, dockerfile: string, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.image = image;
    this.source = source;
    this.dockerfile = dockerfile;
    this.createdAt = createdAt;
  }
}

export function userEnvironmentRepository(): DbRepository {
  return entityUserEnvironment;
}

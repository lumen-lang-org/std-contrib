import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

/** One entry into an environment's own origin: a token in a URL, good once and
 *  for about a minute. The row is the whole credential — see env-grants.ts for
 *  why it is not signed — so its shape is declared here rather than in a
 *  hand-written field() list beside the code that spends it. */
@entity("env_grants")
export class EnvGrant {
  @Id
  @Column("id", "text")
  id: string;

  @Column("slug", "text")
  slug: string;

  @Column("owner", "text")
  owner: string;

  @Column("expires_at", "text")
  expiresAt: string;

  /** Empty until it is spent, and a stamp forever after. */
  @Column("used_at", "text")
  usedAt: string;

  @Column("created_at", "text")
  createdAt: string;

  constructor(id: string, slug: string, owner: string, expiresAt: string,
              usedAt: string, createdAt: string) {
    this.id = id;
    this.slug = slug;
    this.owner = owner;
    this.expiresAt = expiresAt;
    this.usedAt = usedAt;
    this.createdAt = createdAt;
  }
}

export function envGrantRepository(): DbRepository {
  return entityEnvGrant;
}

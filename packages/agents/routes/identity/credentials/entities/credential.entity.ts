import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

@entity("provider_credentials")
export class Credential {
  @Id
  @Column("id", "text")
  id: string;

  @Column("provider", "text")
  provider: string;

  @Column("envelope", "text")
  envelope: string;

  @Column("updated_at", "text")
  updatedAt: string;

  constructor(id: string, provider: string, envelope: string, updatedAt: string) {
    this.id = id;
    this.provider = provider;
    this.envelope = envelope;
    this.updatedAt = updatedAt;
  }
}

export function credentialRepository(): DbRepository {
  return entityCredential;
}

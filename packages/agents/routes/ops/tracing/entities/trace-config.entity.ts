import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

export type TraceConfigRow = {
  id: string,
  backend: string,
  endpoint: string,
  publicKey: string,
  serviceName: string,
  environment: string,
  enabled: bool,
};

@entity("trace_config")
export class TraceConfig {
  @Id
  @Column("id", "text")
  id: string;

  @Column("backend", "text")
  backend: string;

  @Column("endpoint", "text")
  endpoint: string;

  @Column("public_key", "text")
  publicKey: string;

  @Column("service_name", "text")
  serviceName: string;

  @Column("environment", "text")
  environment: string;

  @Column("enabled", "bool")
  enabled: bool;

  constructor(id: string, backend: string, endpoint: string, publicKey: string, serviceName: string, environment: string, enabled: bool) {
    this.id = id;
    this.backend = backend;
    this.endpoint = endpoint;
    this.publicKey = publicKey;
    this.serviceName = serviceName;
    this.environment = environment;
    this.enabled = enabled;
  }
}

export function traceConfigRepository(): DbRepository {
  return entityTraceConfig;
}

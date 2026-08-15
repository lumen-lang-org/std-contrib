import { EntityDescription, entity } from "../../../../../plume/entity.ts";
import { DbRepository } from "../../../../../plume/plume.ts";

/** A container a conversation is building in. The row is what survives a
 *  restart of this engine and of docker: the sweep, the gateway and the sync
 *  all read it rather than asking docker, so it is the record of what should
 *  be running as much as of what is.
 *
 *  The shape migration 64 created is frozen in environments.ts as
 *  envMappingV1(); this class is the table as it stands today, and the two are
 *  deliberately not the same. */
@entity("environments")
export class Environment {
  @Id
  @Column("id", "text")
  id: string;

  @Column("thread_id", "text")
  threadId: string;

  @Column("name", "text")
  name: string;

  @Column("image", "text")
  image: string;

  @Column("network", "int")
  network: int;

  @Column("status", "text")
  status: string;

  /** The name this environment answers to on the wire: 16 hex characters, one
   *  DNS label, and nothing about the conversation it belongs to. */
  @Column("slug", "text")
  slug: string;

  /** The port docker published on the host, or 0 when this environment serves
   *  nothing. Docker picks a new one on every restart. */
  @Column("host_port", "int")
  hostPort: int;

  /** The port inside the container that hostPort reaches. */
  @Column("serve_port", "int")
  servePort: int;

  /** What to run inside to make it serve. */
  @Column("serve_cmd", "text")
  serveCmd: string;

  /** The container's own clock at the last sync, in epoch seconds. */
  @Column("sync_at", "text")
  syncAt: string;

  @Column("created_at", "text")
  createdAt: string;

  @Column("last_used_at", "text")
  lastUsedAt: string;

  constructor(id: string, threadId: string, name: string, image: string, network: int,
              status: string, slug: string, hostPort: int, servePort: int, serveCmd: string,
              syncAt: string, createdAt: string, lastUsedAt: string) {
    this.id = id;
    this.threadId = threadId;
    this.name = name;
    this.image = image;
    this.network = network;
    this.status = status;
    this.slug = slug;
    this.hostPort = hostPort;
    this.servePort = servePort;
    this.serveCmd = serveCmd;
    this.syncAt = syncAt;
    this.createdAt = createdAt;
    this.lastUsedAt = lastUsedAt;
  }
}

export function environmentRepository(): DbRepository {
  return entityEnvironment;
}

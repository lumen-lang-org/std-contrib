import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("card_cases")
export class CardCase {
  @Id
  @Column("id", "text")
  id: string;

  @Column("plugin_id", "text")
  pluginId: string;

  @Column("when_asked", "text")
  when: string;

  @Column("then_do", "text")
  then: string;

  constructor(id: string, pluginId: string, when: string, then: string) {
    this.id = id;
    this.pluginId = pluginId;
    this.when = when;
    this.then = then;
  }
}

export function cardCaseRepository(): DbRepository {
  return entityCardCase;
}

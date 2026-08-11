import { EntityDescription, entity } from "../../../../plume/entity.ts";
import { DbRepository } from "../../../../plume/plume.ts";

@entity("settings")
export class Setting {
  @id
  @column("id", "text")
  id: string;

  @column("value", "text")
  value: string;

  constructor(id: string, value: string) {
    this.id = id;
    this.value = value;
  }
}

export function settingRepository(): DbRepository {
  return entitySetting;
}

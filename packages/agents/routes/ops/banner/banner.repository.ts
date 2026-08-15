import { Db } from "../../../../plume/driver.ts";
import { DbRepository, DbResult, findById, persist } from "../../../../plume/plume.ts";
import { settingRepository } from "../../identity/captcha/entities/setting.entity.ts";
import { SettingRecord } from "../../identity/captcha/dtos/setting-record.dto.ts";

export class BannerRepository {
  database: Db;
  settings: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.settings = settingRepository();
  }

  held(): string {
    return findById(this.database, this.settings, "banner");
  }

  write(value: string): DbResult {
    let row: SettingRecord = { id: "banner", value: value };
    return persist(this.database, this.settings, JSON.stringify(row));
  }
}

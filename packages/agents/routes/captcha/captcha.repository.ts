import { Db } from "../../../plume/driver.ts";
import { DbRepository, DbResult, findById, persist } from "../../../plume/plume.ts";
import { SettingRecord } from "./dtos/setting-record.dto.ts";
import { settingRepository } from "./entities/setting.entity.ts";

export class CaptchaRepository {
  database: Db;
  settings: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.settings = settingRepository();
  }

  held(): string {
    return findById(this.database, this.settings, "captcha");
  }

  write(value: string): DbResult {
    let row: SettingRecord = { id: "captcha", value: value };
    return persist(this.database, this.settings, JSON.stringify(row));
  }
}

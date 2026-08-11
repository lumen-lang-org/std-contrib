import { Db } from "../../../plume/driver.ts";
import { DbRepository, DbResult, findById, persist } from "../../../plume/plume.ts";
import { settingRepository } from "../captcha/entities/setting.entity.ts";
import { SettingRecord } from "../captcha/dtos/setting-record.dto.ts";

const SETTING_KEY: string = "sandbox_limits";

export class SandboxLimitsRepository {
  database: Db;
  settings: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.settings = settingRepository();
  }

  held(): string {
    return findById(this.database, this.settings, SETTING_KEY);
  }

  write(value: string): DbResult {
    let row: SettingRecord = { id: SETTING_KEY, value: value };
    return persist(this.database, this.settings, JSON.stringify(row));
  }
}

import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { SandboxLimits, defaultLimits, refuseSandboxLimits, applySandboxLimits } from "../../../sandbox-limits.ts";
import { SandboxLimitsRepository } from "./sandbox-limits.repository.ts";
import { SettingRecord } from "../../identity/captcha/dtos/setting-record.dto.ts";
import { SandboxLimitsView } from "./dtos/sandbox-limits-view.dto.ts";

export class SandboxLimitsService {
  repository: SandboxLimitsRepository;

  constructor(database: Db) {
    this.repository = new SandboxLimitsRepository(database);
  }

  storedLimits(): SandboxLimits {
    let held = this.repository.held();
    if (held == "") {
      let none: SandboxLimits = {
        envsPerOwner: 0, envsGlobal: 0, keysPerEnv: 0,
        memoryMb: 0, cpus: 0, pidLimit: 0, wallSeconds: 0,
      };
      return none;
    }
    let row: SettingRecord = JSON.parse<SettingRecord>(held);
    return JSON.parse<SandboxLimits>(row.value);
  }

  view(): SandboxLimitsView {
    let v: SandboxLimitsView = { limits: this.storedLimits(), defaults: defaultLimits() };
    return v;
  }

  change(body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: the seven limits, 0 for any that should keep the default");
    }
    let l: SandboxLimits = JSON.parse<SandboxLimits>(body);
    let fault = refuseSandboxLimits(l);
    if (fault != "") {
      return refusing(fault);
    }
    let written = this.repository.write(JSON.stringify(l));
    if (!written.ok) {
      return refusing(written.error);
    }
    applySandboxLimits(this.repository.database);
    return produced(JSON.stringify(this.view()));
  }
}

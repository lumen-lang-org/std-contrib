import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { BannerRepository } from "./banner.repository.ts";
import { bannerFault } from "./banner.utils.ts";
import { BannerAsk } from "./dtos/banner-ask.dto.ts";
import { BannerView } from "./dtos/banner-view.dto.ts";
import { SettingRecord } from "../../identity/captcha/dtos/setting-record.dto.ts";

export class BannerService {
  repository: BannerRepository;

  constructor(database: Db) {
    this.repository = new BannerRepository(database);
  }

  storedText(): string {
    let held = this.repository.held();
    if (held == "") {
      return "";
    }
    let row: SettingRecord = JSON.parse<SettingRecord>(held);
    return row.value;
  }

  view(): BannerView {
    let v: BannerView = { text: this.storedText() };
    return v;
  }

  change(body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"text\":\"...\"}");
    }
    let ask: BannerAsk = JSON.parse<BannerAsk>(body);
    let text = ask.text;
    let fault = bannerFault(text);
    if (fault != "") {
      return refusing(fault);
    }
    let written = this.repository.write(text);
    if (!written.ok) {
      return refusing(written.error);
    }
    let v: BannerView = { text: text };
    return produced(JSON.stringify(v));
  }
}

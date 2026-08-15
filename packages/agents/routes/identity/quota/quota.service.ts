import { Db } from "../../../../plume/driver.ts";
import { GUEST_DAILY_RUNS } from "../../../api-core.ts";
import { nextUtcMidnightIso, utcDayStartText } from "../../../usage.ts";
import { QuotaView } from "./dtos/quota-view.dto.ts";
import { QuotaRepository } from "./quota.repository.ts";

export class QuotaService {
  repository: QuotaRepository;

  constructor(database: Db) {
    this.repository = new QuotaRepository(database);
  }

  forGuest(guest: string, now: number): QuotaView {
    let counted = this.repository.runCountSince(guest, utcDayStartText(now));
    // Display only. An unreadable count shows as none remaining rather than as
    // a full allowance, so the page never overstates what is left.
    let used = counted < 0 ? GUEST_DAILY_RUNS : counted;
    let left = GUEST_DAILY_RUNS - used;
    if (left < 0) {
      left = 0;
    }
    let view: QuotaView = { limit: GUEST_DAILY_RUNS, used: used, remaining: left,
      resetsAt: nextUtcMidnightIso(now) };
    return view;
  }
}

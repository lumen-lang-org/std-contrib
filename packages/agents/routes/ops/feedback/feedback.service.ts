import { Db } from "../../../../plume/driver.ts";
import { jsonText } from "../../../scan.ts";
import { FeedbackAsk, feedbackListing, feedbackPerOwnerDay, feedbackToday, forgetFeedback, sendFeedback } from "../../../feedback.ts";

export type FeedbackOutcome = {
  fault: string,
  document: string,
};

export class FeedbackService {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  /** Whether this person may send, and how many are left today. */
  mine(owner: string): string {
    if (owner == "") {
      return "{\"maySend\":false,\"left\":0}";
    }
    let allowed = feedbackPerOwnerDay();
    if (allowed <= 0) {
      // No limit: -1 rather than a number, so the console shows no count.
      return "{\"maySend\":true,\"left\":-1}";
    }
    let used = feedbackToday(this.database, owner, Date.now() as number);
    let left = used < 0 ? 0 : allowed - used;
    if (left < 0) {
      left = 0;
    }
    return "{\"maySend\":" + (left > 0 ? "true" : "false") + ",\"left\":" + `${left}` + "}";
  }

  send(owner: string, body: string): FeedbackOutcome {
    let ask: FeedbackAsk = {
      owner: owner,
      said: jsonText(body, "said"),
      url: jsonText(body, "url"),
      shot: jsonText(body, "shot"),
      nowMs: Date.now() as number,
    };
    let sent = sendFeedback(this.database, ask);
    if (!sent.ok) {
      let no: FeedbackOutcome = { fault: sent.fault, document: "" };
      return no;
    }
    let yes: FeedbackOutcome = {
      fault: "",
      document: "{\"ok\":true,\"left\":" + `${sent.left}` + "}",
    };
    return yes;
  }

  listing(): string {
    return feedbackListing(this.database, 200);
  }

  forget(id: string): string {
    return forgetFeedback(this.database, id);
  }
}

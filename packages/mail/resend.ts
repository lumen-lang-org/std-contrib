/* Resend, as a Mailer.
 *
 * One POST with a JSON body and a bearer token. The service refuses any from
 * address whose domain the account has not verified, which is worth knowing
 * before blaming this file: a 403 here is nearly always a domain that was
 * never set up rather than a key that is wrong.
 */

import { MailMessage, MailReply, Mailer, mailDelivered, mailFailed } from "./mail.ts";

const RESEND_ENDPOINT: string = "https://api.resend.com/emails";

function resendBody(message: MailMessage): string {
  let out = "{\"from\":" + JSON.stringify(message.from) + ",\"to\":[";
  let i: int = 0;
  while (i < message.to.length) {
    if (i > 0) {
      out = out + ",";
    }
    out = out + JSON.stringify(message.to[i]);
    i = i + 1;
  }
  out = out + "],\"subject\":" + JSON.stringify(message.subject)
    + ",\"html\":" + JSON.stringify(message.html)
    + ",\"text\":" + JSON.stringify(message.text);
  if (message.replyTo != "") {
    out = out + ",\"reply_to\":" + JSON.stringify(message.replyTo);
  }
  return out + "}";
}

function resendDeliver(key: string, message: MailMessage): MailReply {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  headers.set("authorization", "Bearer " + key);
  let res = http.request(RESEND_ENDPOINT, "POST", resendBody(message), headers);
  if (res.status < 0) {
    return mailFailed("no answer from Resend");
  }
  if (res.status < 200 || res.status > 299) {
    let said = res.body.length > 300 ? res.body.slice(0, 300) : res.body;
    return mailFailed("Resend refused it: HTTP " + `${res.status}`
      + (said == "" ? "" : " " + said));
  }
  return mailDelivered(jsonOnly(res.body, "id"));
}

/** The service's own handle for the message. Read with a scan rather than a
 *  parser so this module carries no dependency for one field. */
export function jsonOnly(document: string, field: string): string {
  let key = "\"" + field + "\"";
  let at = document.indexOf(key);
  if (at < 0) {
    return "";
  }
  let colon = document.indexOf(":", at + key.length);
  if (colon < 0) {
    return "";
  }
  let open = document.indexOf("\"", colon);
  if (open < 0) {
    return "";
  }
  let close = document.indexOf("\"", open + 1);
  if (close < 0) {
    return "";
  }
  return document.slice(open + 1, close);
}

export function resendMailer(): Mailer {
  let out: Mailer = {
    name: "resend",
    credential: "resend",
    deliver: resendDeliver,
  };
  return out;
}

/* SendGrid, as a Mailer.
 *
 * Here to keep the interface honest: a second service whose wire format is
 * nothing like the first — recipients nest inside personalizations, the body
 * is a list of typed contents, and a success is 202 with an empty body, so
 * there is no id to hand back. If a Mailer can carry both of these it can
 * carry the next one.
 */

import { MailMessage, MailReply, Mailer, mailDelivered, mailFailed } from "./mail.ts";

const SENDGRID_ENDPOINT: string = "https://api.sendgrid.com/v3/mail/send";

/** "Name <a@b.com>" or a bare address, as SendGrid's {email, name} object. */
function sendgridAddress(said: string): string {
  let open = said.indexOf("<");
  if (open > 0 && said.endsWith(">")) {
    let name = said.slice(0, open).trim();
    let address = said.slice(open + 1, said.length - 1).trim();
    return "{\"email\":" + JSON.stringify(address) + ",\"name\":" + JSON.stringify(name) + "}";
  }
  return "{\"email\":" + JSON.stringify(said.trim()) + "}";
}

function sendgridBody(message: MailMessage): string {
  let to = "";
  let i: int = 0;
  while (i < message.to.length) {
    if (i > 0) {
      to = to + ",";
    }
    to = to + sendgridAddress(message.to[i]);
    i = i + 1;
  }
  let out = "{\"personalizations\":[{\"to\":[" + to + "]}]"
    + ",\"from\":" + sendgridAddress(message.from)
    + ",\"subject\":" + JSON.stringify(message.subject)
    + ",\"content\":[{\"type\":\"text/plain\",\"value\":" + JSON.stringify(message.text) + "}"
    + ",{\"type\":\"text/html\",\"value\":" + JSON.stringify(message.html) + "}]";
  if (message.replyTo != "") {
    out = out + ",\"reply_to\":" + sendgridAddress(message.replyTo);
  }
  return out + "}";
}

function sendgridDeliver(key: string, message: MailMessage): MailReply {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  headers.set("authorization", "Bearer " + key);
  let res = http.request(SENDGRID_ENDPOINT, "POST", sendgridBody(message), headers);
  if (res.status < 0) {
    return mailFailed("no answer from SendGrid");
  }
  if (res.status < 200 || res.status > 299) {
    let said = res.body.length > 300 ? res.body.slice(0, 300) : res.body;
    return mailFailed("SendGrid refused it: HTTP " + `${res.status}`
      + (said == "" ? "" : " " + said));
  }
  // A 202 and an empty body: accepted, with nothing to call it by.
  return mailDelivered("");
}

export function sendgridMailer(): Mailer {
  let out: Mailer = {
    name: "sendgrid",
    credential: "sendgrid",
    deliver: sendgridDeliver,
  };
  return out;
}

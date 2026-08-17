/* Which transport this deployment sends through, and the key it sends with.
 *
 * The mail package knows how to send; it deliberately knows nothing about
 * where a key is kept or who this deployment is. This file is the join: it
 * picks a transport by name, reads that transport's credential out of the
 * encrypted store, and dresses the message as Joule.
 *
 * Adding a service is a line in `mailerFor` and nothing else. Configuring one
 * is AGENTS_MAIL_PROVIDER plus a credential stored under the same name.
 */

import { Db } from "../plume/driver.ts";
import { MailAsk, MailPost, MailSent, Mailer, mailRefused, mailWith } from "../mail/mail.ts";
import { resendMailer } from "../mail/resend.ts";
import { sendgridMailer } from "../mail/sendgrid.ts";
import { credentialFor } from "./credentials.ts";

const MAIL_BRAND: string = "Joule";

const MAIL_FOOTER: string = "Sent by an agent on Joule.";

/* The mark, where a mail client can fetch it. AGENTS_MAIL_LOGO moves it for a
 * deployment served from another origin; empty leaves the name on its own,
 * which is better than a broken image. */
const MAIL_LOGO: string = "https://joule.sh/mail-mark.png";

function mailLogo(): string {
  let said = (process.env("AGENTS_MAIL_LOGO") ?? "").trim();
  return said == "" ? MAIL_LOGO : said;
}

/* What a test sets instead of the environment.
 *
 * A Lumen program reads its configuration from the environment and cannot
 * write it, so a suite that wanted to prove "no address means no tool" had no
 * way to say it. The same shape environments.ts and office-render.ts use, and
 * for the same reason: empty means read the environment, so nothing here
 * changes what a deployment does. */
let mailFromChosen: string = "";
let mailProviderPicked: string = "";

export function mailFromOverride(address: string): void {
  mailFromChosen = address;
}

export function mailProviderOverride(name: string): void {
  mailProviderPicked = name;
}

export function mailProviderNames(): string[] {
  return ["resend", "sendgrid"];
}

/** The transport a deployment has configured. Resend is the default because
 *  it is the one joule.sh sends through; a deployment that wants another
 *  names it and stores that service's key. */
export function mailProviderChosen(): string {
  if (mailProviderPicked != "") {
    return mailProviderPicked;
  }
  let said = (process.env("AGENTS_MAIL_PROVIDER") ?? "").trim().toLowerCase();
  return said == "" ? "resend" : said;
}

export type MailerLookup = {
  ok: bool,
  mailer: Mailer,
  fault: string,
};

export function mailerFor(name: string): MailerLookup {
  if (name == "resend") {
    let one: MailerLookup = { ok: true, mailer: resendMailer(), fault: "" };
    return one;
  }
  if (name == "sendgrid") {
    let two: MailerLookup = { ok: true, mailer: sendgridMailer(), fault: "" };
    return two;
  }
  let none: MailerLookup = {
    ok: false,
    mailer: resendMailer(),
    fault: "\"" + name + "\" is not a mail service this deployment can send through;"
      + " AGENTS_MAIL_PROVIDER takes " + mailProviderNames().join(" or "),
  };
  return none;
}

export function mailFrom(): string {
  if (mailFromChosen != "") {
    return mailFromChosen;
  }
  return (process.env("AGENTS_MAIL_FROM") ?? "").trim();
}

export function mailReplyTo(): string {
  return (process.env("AGENTS_MAIL_REPLY_TO") ?? "").trim();
}

/** Whether mail can be sent at all, said in one line. Used by a tool to decide
 *  whether to offer itself: a tool that is certain to fail is worse than an
 *  absent one, because the model tells somebody it sent the mail. */
export function mailReady(db: Db, master: string): bool {
  if (mailFrom() == "") {
    return false;
  }
  let found = mailerFor(mailProviderChosen());
  if (!found.ok) {
    return false;
  }
  return credentialFor(db, found.mailer.credential, master) != "";
}

export function sendMail(db: Db, master: string, ask: MailAsk): MailSent {
  let found = mailerFor(mailProviderChosen());
  if (!found.ok) {
    return mailRefused(found.fault);
  }
  let post: MailPost = {
    from: mailFrom(),
    replyTo: mailReplyTo(),
    key: credentialFor(db, found.mailer.credential, master),
    brand: MAIL_BRAND,
    logo: mailLogo(),
    footer: MAIL_FOOTER,
  };
  return mailWith(found.mailer, post, ask);
}

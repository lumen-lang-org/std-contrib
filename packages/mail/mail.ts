/* Mail: one function to hand a message over, and the handful of things every
 * transport needs told.
 *
 * A `Mailer` is the interface — the same shape plume's `Db` has, and for the
 * same reason. Nothing in this file knows about any particular service: it
 * validates an ask, turns prose into a mail, and hands the result to whatever
 * transport it was given. A transport lives in its own module, so adding one
 * is a file and a line in a caller's registry, and touching one cannot break
 * the others. `resend.ts` and `sendgrid.ts` are the two that ship here.
 *
 * Two things a transport is NOT allowed to decide:
 *
 *   The address it comes from. That belongs to the program's configuration,
 *   so code that composes a message can never choose who it appears to be
 *   from. In a program that lets a model write the message, that is the whole
 *   guard against it being a spoofing tool.
 *
 *   What the message looks like. The HTML shell is here, once, so switching
 *   service does not change what lands in somebody's inbox.
 *
 * Plain text in, HTML out. Prose pasted into a mail body arrives as one long
 * line with its paragraphs gone, so blank lines become paragraphs and single
 * newlines become breaks. The text alternative is the prose, unchanged.
 */


/** The most a single mail may carry, so a runaway loop cannot mail a
 *  megabyte. Roughly forty pages of prose. */
const MAIL_BODY_MAX: int = 100000;

const MAIL_SUBJECT_MAX: int = 200;

/** How many addresses one call may name. A mail to a hundred people is a
 *  mailing list, and a mailing list is not this. */
const MAIL_TO_MAX: int = 10;

/** A message, after this file has made it and before a transport sends it.
 *  Every transport is handed the same one. */
export type MailMessage = {
  from: string,
  to: string[],
  replyTo: string,
  subject: string,
  html: string,
  text: string,
};

/** What a transport answers. `id` is the service's own handle for the message
 *  when it gives one, kept because it is the only thing that makes a delivery
 *  question answerable later. */
export type MailReply = {
  ok: bool,
  id: string,
  fault: string,
};

/** A transport. Implementations live in their own modules and are listed in
 *  mail-send.ts; nothing else imports one directly. */
export type Mailer = {
  // The name a deployment configures, and the name a diagnostic uses.
  name: string,
  // Which credential this transport reads. Usually the name, but a service
  // whose key is shared with something else can say so here.
  credential: string,
  // Hand the message over. The key is already decrypted; the transport
  // renders whatever wire format its service wants and answers what happened.
  // It never retries: a caller that wants a retry can see the fault.
  deliver: (key: string, message: MailMessage) => MailReply,
};

export type MailAsk = {
  to: string,
  subject: string,
  body: string,
};

export type MailSent = {
  ok: bool,
  id: string,
  to: string,
  fault: string,
};

export function mailRefused(why: string): MailSent {
  let out: MailSent = { ok: false, id: "", to: "", fault: why };
  return out;
}

export function mailFailed(why: string): MailReply {
  let out: MailReply = { ok: false, id: "", fault: why };
  return out;
}

export function mailDelivered(id: string): MailReply {
  let out: MailReply = { ok: true, id: id, fault: "" };
  return out;
}

/** Enough of an address to fail before a request rather than after one:
 *  something, an @, something with a dot in it, and no spaces or commas that
 *  would turn one address into two on the far side. */
export function mailAddressOk(said: string): bool {
  let at = said.indexOf("@");
  if (at < 1 || at != said.lastIndexOf("@")) {
    return false;
  }
  let host = said.slice(at + 1);
  if (host.length < 3 || host.indexOf(".") < 1 || host.endsWith(".")) {
    return false;
  }
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c <= 32 || c == 44 || c == 60 || c == 62 || c == 34 || c == 59) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

/** The addresses in a "a@b.com, c@d.com" list, refusing the whole list if any
 *  one of them is not an address — a mail half sent is worse than none. */
export type MailTo = {
  ok: bool,
  addresses: string[],
  fault: string,
};

export function mailRecipients(said: string): MailTo {
  let none: string[] = [];
  let parts = said.split(",");
  let out: string[] = [];
  let i: int = 0;
  while (i < parts.length) {
    let one = parts[i].trim();
    if (one != "") {
      if (!mailAddressOk(one)) {
        let bad: MailTo = { ok: false, addresses: none,
          fault: "\"" + one + "\" is not an email address" };
        return bad;
      }
      out.push(one);
    }
    i = i + 1;
  }
  if (out.length == 0) {
    let empty: MailTo = { ok: false, addresses: none,
      fault: "name at least one address to send to" };
    return empty;
  }
  if (out.length > MAIL_TO_MAX) {
    let many: MailTo = { ok: false, addresses: none,
      fault: "one mail goes to at most " + `${MAIL_TO_MAX}` + " addresses; this one names "
        + `${out.length}` };
    return many;
  }
  let ok: MailTo = { ok: true, addresses: out, fault: "" };
  return ok;
}

export function mailEscape(said: string): string {
  let out = "";
  let i: int = 0;
  while (i < said.length) {
    let c = said.charAt(i);
    if (c == "&") {
      out = out + "&amp;";
    } else if (c == "<") {
      out = out + "&lt;";
    } else if (c == ">") {
      out = out + "&gt;";
    } else if (c == "\"") {
      out = out + "&quot;";
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

/** Prose to paragraphs. A blank line starts a new one; a single newline is a
 *  line break inside the same one, which is how somebody writing a list in a
 *  chat expects it to arrive. */
export function mailParagraphs(body: string): string {
  let out = "";
  let blocks = body.replace("\r\n", "\n").split("\n\n");
  let i: int = 0;
  while (i < blocks.length) {
    let block = blocks[i].trim();
    if (block != "") {
      let text = mailEscape(block).split("\n").join("<br>");
      out = out + "<p style=\"font-size:15px; color:#333b3f; line-height:1.6;"
        + " margin:0 0 16px;\">" + text + "</p>\n";
    }
    i = i + 1;
  }
  return out;
}

/** How a program's mail is dressed: the name at the top and the line at the
 *  bottom. Two strings rather than a template hook, because a program that
 *  wants its own markup can render the html itself and pass it through. */
export type MailLook = {
  brand: string,
  footer: string,
};

/** The shell a mail is wrapped in. Table-based, because that is the one
 *  layout every mail client agrees on. */
export function mailHtml(look: MailLook, subject: string, body: string): string {
  return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
    + "<title>" + mailEscape(subject) + "</title></head>"
    + "<body style=\"margin:0; padding:0; background-color:#f7f9f9;"
    + " font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;\">"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\""
    + " style=\"background-color:#f7f9f9;\"><tr><td align=\"center\" style=\"padding:40px 20px;\">"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\""
    + " style=\"max-width:560px; background-color:#ffffff; border-radius:12px; overflow:hidden;\">"
    + "<tr><td style=\"padding:32px 40px 0;\">"
    + "<div style=\"font-size:14px; font-weight:700; color:#0f1419;\">"
    + mailEscape(look.brand) + "</div>"
    + "</td></tr>"
    + "<tr><td style=\"padding:20px 40px 36px;\">"
    + "<h1 style=\"font-size:20px; font-weight:800; color:#0f1419; margin:0 0 16px;"
    + " line-height:1.35;\">" + mailEscape(subject) + "</h1>\n"
    + mailParagraphs(body)
    + "</td></tr></table>"
    + "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\""
    + " style=\"max-width:560px;\"><tr><td style=\"padding:20px 40px; text-align:center;"
    + " font-size:12px; color:#536471; line-height:1.5;\">"
    + mailEscape(look.footer) + "</td></tr></table>"
    + "</td></tr></table></body></html>";
}

/** What is wrong with an ask before anything is sent, or "" if it is sound.
 *  Separate from sending so a tool, a step and a test all refuse alike. */
export function mailFault(ask: MailAsk): string {
  if (ask.subject.trim() == "") {
    return "a mail needs a subject";
  }
  if (ask.subject.length > MAIL_SUBJECT_MAX) {
    return "a subject is at most " + `${MAIL_SUBJECT_MAX}` + " characters";
  }
  if (ask.subject.indexOf("\n") >= 0 || ask.subject.indexOf("\r") >= 0) {
    return "a subject is one line";
  }
  if (ask.body.trim() == "") {
    return "an empty mail says nothing; write the message";
  }
  if (ask.body.length > MAIL_BODY_MAX) {
    return "a mail body is at most " + `${MAIL_BODY_MAX}` + " characters; this one is "
      + `${ask.body.length}`;
  }
  return "";
}

export type MailPost = {
  // Who it is from, as configured — "Joule <hello@joule.sh>" or a bare
  // address. Never composed from anything a caller was handed.
  from: string,
  // Where a reply should go when that is not the from address. Empty to leave
  // it out of the message entirely.
  replyTo: string,
  // The transport's credential, already decrypted. This module never reads a
  // key store: whoever holds the keys hands one over.
  key: string,
  brand: string,
  footer: string,
};

/** Validate, render, hand over. The transport is given rather than chosen, so
 *  a test sends through a fake one and nothing here needs a network. */
export function mailWith(mailer: Mailer, post: MailPost, ask: MailAsk): MailSent {
  if (post.from == "") {
    return mailRefused("there is no address to send from: configure one at a domain"
      + " the mail service has verified");
  }
  if (post.key == "") {
    return mailRefused("no credential for " + mailer.credential
      + ": store one before anything can be sent");
  }
  let bad = mailFault(ask);
  if (bad != "") {
    return mailRefused(bad);
  }
  let who = mailRecipients(ask.to);
  if (!who.ok) {
    return mailRefused(who.fault);
  }

  let look: MailLook = { brand: post.brand, footer: post.footer };
  let message: MailMessage = {
    from: post.from,
    to: who.addresses,
    replyTo: post.replyTo,
    subject: ask.subject,
    html: mailHtml(look, ask.subject, ask.body),
    text: ask.body,
  };
  let handed = mailer.deliver(post.key, message);
  if (!handed.ok) {
    return mailRefused(handed.fault);
  }
  let sent: MailSent = { ok: true, id: handed.id, to: who.addresses.join(", "), fault: "" };
  return sent;
}

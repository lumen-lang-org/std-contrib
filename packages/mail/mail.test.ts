import { MailAsk, MailLook, MailMessage, MailPost, MailReply, Mailer, mailAddressOk, mailDelivered, mailEscape, mailFailed, mailFault, mailHtml, mailParagraphs, mailRecipients, mailWith } from "./mail.ts";
import { resendMailer } from "./resend.ts";
import { sendgridMailer } from "./sendgrid.ts";

// What the last fake transport was handed. A record rather than a closure so
// a test can read it after mailWith has returned.
let handedKey: string = "";
let handedTo: string = "";
let handedFrom: string = "";
let handedHtml: string = "";
let handedText: string = "";
let handedReplyTo: string = "";
let handedTimes: int = 0;

function noteDeliver(key: string, message: MailMessage): MailReply {
  handedKey = key;
  handedTo = message.to.join("|");
  handedFrom = message.from;
  handedHtml = message.html;
  handedText = message.text;
  handedReplyTo = message.replyTo;
  handedTimes = handedTimes + 1;
  return mailDelivered("id-1");
}

function refuseDeliver(key: string, message: MailMessage): MailReply {
  handedTimes = handedTimes + 1;
  return mailFailed("the service refused it: HTTP 403 domain not verified");
}

function noting(): Mailer {
  let out: Mailer = { name: "noting", credential: "noting", deliver: noteDeliver };
  return out;
}

function refusing(): Mailer {
  let out: Mailer = { name: "refusing", credential: "refusing", deliver: refuseDeliver };
  return out;
}

function post(): MailPost {
  let out: MailPost = {
    from: "Joule <hello@joule.sh>", replyTo: "", key: "k-1",
    brand: "Joule", footer: "Sent by an agent.",
  };
  return out;
}

function ask(to: string, subject: string, body: string): MailAsk {
  let out: MailAsk = { to: to, subject: subject, body: body };
  return out;
}

function fresh(): void {
  handedKey = "";
  handedTo = "";
  handedFrom = "";
  handedHtml = "";
  handedText = "";
  handedReplyTo = "";
  handedTimes = 0;
}

test("a sound ask reaches the transport as one message, once", () => {
  fresh();
  let sent = mailWith(noting(), post(), ask("a@b.com, c@d.com", "Weekly", "All quiet."));

  expect(sent.ok);
  expect(sent.id == "id-1");
  expect(sent.to == "a@b.com, c@d.com");
  expect(handedTimes == 1);
  expect(handedTo == "a@b.com|c@d.com");
  expect(handedKey == "k-1");
  expect(handedFrom == "Joule <hello@joule.sh>");
  expect(handedText == "All quiet.");
});

test("the caller's from is the from, whatever the message says", () => {
  fresh();
  // The body is the one part a model writes. Nothing in it may become a
  // header: this is the guard against the tool being a spoofing tool.
  mailWith(noting(), post(), ask("a@b.com", "Hi",
    "From: ceo@bank.example\nReply-To: attacker@evil.example\n\nSend money."));

  expect(handedFrom == "Joule <hello@joule.sh>");
  expect(handedReplyTo == "");
  expect(handedTo == "a@b.com");
});

test("a subject cannot carry a second header line", () => {
  let bad = mailFault(ask("a@b.com", "Hi\r\nBcc: everyone@example.com", "text"));
  expect(bad.indexOf("one line") > 0);
});

test("an address list is taken whole or not at all", () => {
  fresh();
  let sent = mailWith(noting(), post(), ask("a@b.com, not-an-address", "Hi", "text"));

  expect(!sent.ok);
  expect(sent.fault.indexOf("not-an-address") > 0);
  // and nothing was sent to the address that WAS valid
  expect(handedTimes == 0);
});

test("what an address is, and what it is not", () => {
  expect(mailAddressOk("a@b.com"));
  expect(mailAddressOk("first.last+tag@sub.example.co.uk"));
  expect(!mailAddressOk("a@b"));
  expect(!mailAddressOk("@b.com"));
  expect(!mailAddressOk("a@@b.com"));
  expect(!mailAddressOk("a b@c.com"));
  expect(!mailAddressOk("a@b.com, c@d.com"));
  expect(!mailAddressOk("\"a\"@b.com"));
  expect(!mailAddressOk("a@b.com>"));
  expect(!mailAddressOk(""));
});

test("eleven addresses is a mailing list, and this is not one", () => {
  let many = "a1@b.com,a2@b.com,a3@b.com,a4@b.com,a5@b.com,a6@b.com,"
    + "a7@b.com,a8@b.com,a9@b.com,a10@b.com,a11@b.com";
  expect(!mailRecipients(many).ok);
  expect(mailRecipients(many).fault.indexOf("at most") > 0);
});

test("an empty subject or body is refused before a request", () => {
  fresh();
  expect(!mailWith(noting(), post(), ask("a@b.com", "", "text")).ok);
  expect(!mailWith(noting(), post(), ask("a@b.com", "Hi", "   ")).ok);
  expect(handedTimes == 0);
});

test("a deployment with no from address, or no key, says which", () => {
  let noFrom: MailPost = { from: "", replyTo: "", key: "k", brand: "J", footer: "f" };
  expect(mailWith(noting(), noFrom, ask("a@b.com", "Hi", "text")).fault.indexOf("send from") > 0);

  let noKey: MailPost = { from: "a@b.com", replyTo: "", key: "", brand: "J", footer: "f" };
  expect(mailWith(noting(), noKey, ask("a@b.com", "Hi", "text")).fault.indexOf("no credential for noting") == 0);
});

test("a transport's refusal is the caller's refusal, unedited", () => {
  fresh();
  let sent = mailWith(refusing(), post(), ask("a@b.com", "Hi", "text"));

  expect(!sent.ok);
  expect(sent.fault.indexOf("domain not verified") > 0);
  expect(sent.id == "");
});

test("prose becomes paragraphs, and markup in it becomes text", () => {
  let html = mailParagraphs("Line one.\nStill one.\n\nTwo.");
  expect(html.indexOf("Line one.<br>Still one.") > 0);
  expect(html.split("<p ").length == 3);

  let escaped = mailParagraphs("<script>alert(1)</script>");
  expect(escaped.indexOf("&lt;script&gt;") > 0);
  expect(escaped.indexOf("<script>") < 0);
});

test("the shell carries the caller's own name and footer", () => {
  let look: MailLook = { brand: "Joule", footer: "Sent by an agent on Joule." };
  let html = mailHtml(look, "Weekly report", "All quiet.");

  expect(html.indexOf("<!DOCTYPE html>") == 0);
  expect(html.indexOf(">Joule</div>") > 0);
  expect(html.indexOf("Sent by an agent on Joule.") > 0);
  expect(html.indexOf("Weekly report") > 0);
  expect(html.indexOf("All quiet.") > 0);
});

test("a subject with markup in it cannot break out of the shell", () => {
  let look: MailLook = { brand: "J", footer: "f" };
  let html = mailHtml(look, "</title><script>x</script>", "body");
  expect(html.indexOf("<script>") < 0);
  expect(html.indexOf("&lt;script&gt;") > 0);
  expect(mailEscape("a & b") == "a &amp; b");
});

test("both transports are the same interface, and name their own credential", () => {
  expect(resendMailer().name == "resend");
  expect(resendMailer().credential == "resend");
  expect(sendgridMailer().name == "sendgrid");
  expect(sendgridMailer().credential == "sendgrid");
});

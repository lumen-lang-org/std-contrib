# mail

Sending mail from a Lumen program. One `Mailer` interface, one module per
service, one HTML shell.

```ts
export type Mailer = {
  name: string,
  credential: string,
  deliver: (key: string, message: MailMessage) => MailReply,
};
```

Ships with `resend.ts` and `sendgrid.ts`.

## Use

```ts
import { MailAsk, MailPost, mailWith } from "./mail.ts";
import { resendMailer } from "./resend.ts";

let post: MailPost = {
  from: "Joule <hello@joule.sh>",
  replyTo: "",
  key: apiKey,                       // already decrypted; this package reads no key store
  brand: "Joule",
  footer: "Sent by an agent on Joule.",
};
let ask: MailAsk = {
  to: "someone@example.com, another@example.com",
  subject: "Weekly report",
  body: "All quiet.\n\nNothing needed your attention this week.",
};

let sent = mailWith(resendMailer(), post, ask);
if (!sent.ok) {
  print(sent.fault);
}
```

The body is prose. Blank lines become paragraphs, single newlines become
breaks, and the plain-text part is what you wrote, unchanged.

`from` comes from the caller, never from the message.

## Refused before a request

- an address that is not one — and the whole list, not the addresses either
  side of the typo
- more than ten recipients
- a newline in the subject
- an empty subject or body
- a body over 100,000 characters

## Answers

`mailWith` says whether the service accepted the message. Whether it arrived is
the service's own webhooks; `MailReply.id` is kept so a program can ask later.
SendGrid returns 202 with no body, so `id` is empty there.

## Adding a service

A module with a `deliver` and a constructor, and a line wherever your program
picks one. `mail.ts` does not change.

# A file sent to a bot

Today a file sent to a Telegram bot is ignored, and ignored *silently*:
`updatesIn` keeps updates that carry text and steps over everything else, so a
document produces no inbox row, no run, and no reply. That silence is right
for a reaction or a join. It is wrong for a file, because sending one is a
person asking a question.

This is the plan for making it not wrong. It is deliberately one slice.

## What has to be true for it to work at all

**Telegram does not send bytes.** An update carries a `file_id` and nothing
else useful. Getting the bytes is two more calls:

```
getFile(file_id)              -> { file_path: "documents/file_12.pdf" }
GET https://api.telegram.org/file/bot<token>/<file_path>   -> the bytes
```

Three consequences, all of which shape the work:

- **A second host.** Every other call in `trigger-poller.ts` goes to
  `api.telegram.org/bot<token>/<method>`; the download goes to
  `api.telegram.org/file/bot<token>/<path>`. Same token, different shape, and
  the token is in the URL for both — so the same rule applies: never logged.
- **`file_path` expires** (about an hour) and is the only way back to the
  bytes. So the download happens in the same pass as the poll, not later from
  a queue — which is the one place this plan puts work in the poller rather
  than in the scheduler.
- **20MB is Telegram's ceiling** for what a bot may download. Ours is lower;
  see below.

**Nothing else is missing.** Everything downstream already exists and was
checked rather than assumed:

| what is needed | what already provides it |
|---|---|
| bytes over HTTP | `http.request` — a Lumen string carries arbitrary bytes; the runtime does no transcoding |
| bytes into storage | `crypto.base64Encode` (spec 474), namespaced |
| a file on a conversation | `createArtifact` — the same call the console's own upload makes |
| the agent reading it | whatever it already does with a console upload, by construction |

That last row is the whole design. A console upload becomes an artifact on a
thread; a Telegram upload should become *the same artifact on the same kind of
thread*, so extraction, the document viewer, the artifact panel and every tool
that reads one all work without knowing Telegram exists.

## The slice

**Documents only.** A `document` update, with its caption as the instruction.

Not photos, not voice, not video, not albums — each of those is a different
question (vision, transcription, grouping) wearing the same clothes, and
answering them together is how a slice becomes a quarter.

The flow, with the existing pipeline unchanged around it:

```
poller: update has a document
  -> getFile, download, refuse if too big        (new, in the poller)
  -> inbox row: input = caption, bytes parked    (two new columns)
scheduler: claims the row
  -> opens or continues the chat's conversation  (existing)
  -> createArtifact on it, from the parked bytes (existing call)
  -> runs the workflow with the artifact in reach
  -> answer -> sent                              (unchanged)
```

**The split is not arbitrary, and the first draft of this plan got it wrong.**
It had the poller create the artifact directly, which cannot work: an artifact
belongs to a conversation, and on a chat's FIRST message no conversation
exists — the scheduler opens it when the run starts. So the poller does only
the part that cannot wait (the download, because `file_path` expires within
the hour) and parks the bytes; the scheduler does the part that needs a
thread. That also keeps the existing rule intact — the scheduler stays the
only process that touches conversations.

### What changes, file by file

- **`triggers.ts`** — `TriggerUpdate` grows `fileId`, `fileName`, `fileSize`,
  and `updatesIn` stops stepping over an update whose `document` is present.
  A caption becomes the text; an empty caption is not empty any more, because
  the file *is* the message — so the "no text is no instruction" rule needs a
  second clause rather than a rewrite. `TriggerInboxRow` grows `fileName` and
  `fileBody` (base64, parked for the scheduler). New migration `106.3`, and —
  the mistake this file already made once — a frozen `V1` mapping stays
  frozen; a column is an ALTER at a new version.
- **`trigger-poller.ts`** — `fetchDocument(token, fileId)`: getFile, download,
  size check, base64. Per message try, so one file that fails costs one
  message, and the ordering already established holds: the row exists before
  the cursor moves, so a crash mid-download repeats a message rather than
  losing one.
- **`scheduler.ts`** — after the thread exists, `createArtifact` from the
  parked bytes, then run with the artifact in reach. A row whose artifact
  cannot be written fails as a message, with the reason sent to the chat.
- **`workflow.ts`** — `{{file}}` beside `{{input}}`, resolving to the
  artifact's path, so a step can say "summarise {{file}}" the way it already
  says "answer {{input}}".

### The ceilings, and why they are not Telegram's

| limit | value | why |
|---|---|---|
| what Telegram will hand a bot | 20MB | theirs, not ours |
| `AGENTS_ARTIFACT_BYTES_MAX` on joule.sh | 28MB | raised for this, see below |
| what this accepts | whatever Telegram will send | one ceiling, and it is not ours |

The artifact ceiling was 512KB — chosen as "far more than a page a person
reads and far less than a database row anyone should hold in memory", which is
the right instinct for text and the wrong one for a PDF somebody sends a bot.
It is 28MB on this deployment now, and the number is not arbitrary: the cap
measures the **stored** body, base64 is 4/3 of the bytes, and 20MB — all
Telegram will ever hand a bot — encodes to 26.7MB. So the only refusal left
above that is Telegram's own, and the bot never has to explain a limit that
is really ours.

Measured rather than assumed: a 6MB PDF stores through gateway, console proxy
and engine; a 22MB one stores; 30.8MB of base64 is refused with "an artifact
is at most 29360128 bytes; this one is 30834048"; the engine sat at 70MB of
its 2G while doing it.

`AGENTS_THREAD_BYTES_MAX` went with it, 100MB to 500MB — versions are
append-only and every version counts, so a 100MB conversation held three
files of this size and then refused the fourth for a reason nobody could see
from a chat.

The code's own defaults are unchanged (`caps.ts`, 512KB and 100MB). A box
with less memory than this one should not inherit a ceiling chosen for a
deployment that has 2G to spend, and these are environment variables exactly
so that is a unit-file edit rather than a fork.

## What this deliberately does not do

- **Photos, voice, video.** Each needs a decision this plan has no business
  making quietly.
- **Files the bot sends back.** `sendDocument` is the mirror image and is
  worth doing, but a workflow that produces a file is a separate feature from
  one that consumes it.
- **Albums.** Ten photos arrive as ten updates sharing a `media_group_id`,
  so they are ten runs unless something groups them. Ten runs is wrong; the
  grouping is a real design question about waiting for a batch that may never
  complete.
- **Streaming.** The whole file is held in memory as base64, and now also
  parked in a database row between the two processes. At a 512KB
  ceiling that is fine and at 20MB it would not be, which is another reason
  the ceiling stays where it is.

## How it gets tested

The pure half, in `triggers.test.ts` and needing no bot: an update carrying a
document is read (file id, name, size, caption), an update carrying a document
*and* no caption still becomes a message, an oversized file is refused with a
sentence naming both numbers, and a photo is still stepped over.

The live half needs the bot: send a PDF, watch the artifact appear on the
conversation in the console, and read the reply. That is one message and one
screenshot, and it is the only part that cannot be proven on this machine
alone.

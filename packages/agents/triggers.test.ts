// The parts of a trigger that can be wrong without a bot: what Telegram said,
// where the cursor goes next, and what a bot is allowed to cost.
//
// Everything here is pure, which is deliberate — the half that talks to
// Telegram is a poll and a POST, and the half that decides is this.
//
//   cd packages/agents && lumen test triggers.test.ts

import { TRIGGER_INPUT_MAX, TRIGGER_RUNS_PER_DAY, TRIGGER_RUNS_PER_MINUTE, TriggerBotRow, TriggerUpdate, emptyBot, emptyMessage, mayRun, nextOffset, plainly, replyKeyboard, testingDraft, updatesIn, withRunCounted } from "./triggers.ts";

function bot(): TriggerBotRow {
  let base = emptyBot();
  let one: TriggerBotRow = {
    id: "b1", owner: "o1", kind: "telegram", name: "Support",
    workflowId: "w1", credentialRef: "telegram:b1", offset: "0",
    leaseBy: "", leaseUntil: "", enabled: true,
    runsToday: 0, dayStartedAt: "1000", lastAt: "", lastError: base.lastError,
    createdAt: "", updatedAt: "",
  };
  return one;
}

function counted(from: TriggerBotRow, runs: int, dayStartedAt: string): TriggerBotRow {
  let out: TriggerBotRow = {
    id: from.id, owner: from.owner, kind: from.kind, name: from.name,
    workflowId: from.workflowId, credentialRef: from.credentialRef,
    offset: from.offset, leaseBy: from.leaseBy, leaseUntil: from.leaseUntil,
    enabled: from.enabled, runsToday: runs, dayStartedAt: dayStartedAt,
    lastAt: from.lastAt, lastError: from.lastError,
    createdAt: from.createdAt, updatedAt: from.updatedAt,
  };
  return out;
}

const TWO_MESSAGES = "{\"ok\":true,\"result\":["
  + "{\"update_id\":10,\"message\":{\"message_id\":1,\"chat\":{\"id\":555,\"type\":\"private\"},\"text\":\"hello there\"}},"
  + "{\"update_id\":11,\"message\":{\"message_id\":2,\"chat\":{\"id\":555,\"type\":\"private\"},\"text\":\"and again\"}}"
  + "]}";

test("the messages in a getUpdates body, with their chat and their words", () => {
  let seen = updatesIn(TWO_MESSAGES);
  expect(seen.length == 2);
  expect(seen[0].updateId == "10");
  expect(seen[0].chatId == "555");
  expect(seen[0].text == "hello there");
  expect(seen[1].text == "and again");
});

test("everything that is not a message with words is stepped over", () => {
  // A reaction, an edit, a photo with no caption, and a body that is not ok:
  // none of these is an instruction, and a workflow fired by one would run on
  // the empty string or on somebody changing their profile photo.
  let odd = "{\"ok\":true,\"result\":["
    + "{\"update_id\":20,\"edited_message\":{\"chat\":{\"id\":1},\"text\":\"fixed typo\"}},"
    + "{\"update_id\":21,\"message\":{\"chat\":{\"id\":1},\"photo\":[]}},"
    + "{\"update_id\":22,\"message\":{\"chat\":{\"id\":1},\"text\":\"   \"}},"
    + "{\"update_id\":23,\"message\":{\"text\":\"no chat at all\"}}"
    + "]}";
  expect(updatesIn(odd).length == 0);
  expect(updatesIn("{\"ok\":false,\"description\":\"Unauthorized\"}").length == 0);
  expect(updatesIn("").length == 0);
});

test("a very long message is cut before it becomes a row", () => {
  let long = "";
  let i: int = 0;
  while (i < 900) { long = long + "0123456789"; i = i + 1; }
  let body = "{\"ok\":true,\"result\":[{\"update_id\":1,\"message\":{\"chat\":{\"id\":7},\"text\":\"" + long + "\"}}]}";
  let seen = updatesIn(body);
  expect(seen.length == 1);
  expect(seen[0].text.length == TRIGGER_INPUT_MAX);
});

test("the cursor moves past the highest update, and never backwards", () => {
  let seen = updatesIn(TWO_MESSAGES);
  expect(nextOffset(seen, "0") == "12");
  // Nothing new leaves it where it was: asking again with a lower cursor
  // would hand back messages already answered.
  let none: TriggerUpdate[] = [];
  expect(nextOffset(none, "12") == "12");
  expect(nextOffset(seen, "99") == "99");
});

test("a bot's ceilings refuse with a sentence, not with silence", () => {
  let b = bot();
  expect(mayRun(b, 0, 2000.0).ok);

  // The day's bill.
  let spent = counted(b, TRIGGER_RUNS_PER_DAY, "1000");
  let no = mayRun(spent, 0, 2000.0);
  expect(!no.ok);
  expect(no.reason.includes("today"));

  // A burst — a group chat waking up.
  let fast = mayRun(b, TRIGGER_RUNS_PER_MINUTE, 2000.0);
  expect(!fast.ok);
  expect(fast.reason.includes("minute"));

  // Switched off is a refusal too, and says which one it is.
  let off = counted(b, 0, "1000");
  let dark: TriggerBotRow = {
    id: off.id, owner: off.owner, kind: off.kind, name: off.name,
    workflowId: off.workflowId, credentialRef: off.credentialRef,
    offset: off.offset, leaseBy: off.leaseBy, leaseUntil: off.leaseUntil,
    enabled: false, runsToday: off.runsToday, dayStartedAt: off.dayStartedAt,
    lastAt: off.lastAt, lastError: off.lastError,
    createdAt: off.createdAt, updatedAt: off.updatedAt,
  };
  expect(!mayRun(dark, 0, 2000.0).ok);
});

test("the day's count rolls over rather than standing forever", () => {
  let b = counted(bot(), TRIGGER_RUNS_PER_DAY, "1000");
  // A day and a bit later, the same bot is free again — and the ceiling that
  // refused a moment ago now lets it through.
  let later = 1000.0 + 86400000.0 + 1000.0;
  expect(mayRun(b, 0, later).ok);
  let rolled = withRunCounted(b, later);
  expect(rolled.runsToday == 1);
  expect(rolled.dayStartedAt == `${later}`);
  // Within the same day it simply climbs.
  let same = withRunCounted(bot(), 2000.0);
  expect(same.runsToday == 1);
  expect(same.dayStartedAt == "1000");
});

test("an answer is sent as prose, not as the machinery around it", () => {
  let raw = "Tunis is on CET all year.\n\n[FOLLOWUPS]{\"items\":[\"What time is it?\"]}[/FOLLOWUPS]";
  expect(plainly(raw) == "Tunis is on CET all year.");

  // A block the model never closed: everything from the opening tag is
  // machinery, and half of it on screen is worse than none.
  expect(plainly("Here you go.\n[FOLLOWUPS]{\"items\":[").trim() == "Here you go.");

  // An ordinary bracket is not a block, and a markdown link keeps working.
  expect(plainly("See [the docs](https://example.com) for more.") == "See [the docs](https://example.com) for more.");

  // Nothing but a block: the message is sent as it came rather than as
  // nothing at all.
  expect(plainly("[TEXT]{\"body\":\"x\"}[/TEXT]").length > 0);
});

test("the ceilings work at a real clock, not only at toy timestamps", () => {
  // The bug this test exists for: every other test here used stamps like
  // "1000", where `parseInt` and `as int` both behave. At a real epoch an i32
  // is 41 bits short, `nowMs as int` is out of bounds, and the poller
  // crash-looped on its first pass against a live bot.
  let realNow = 1786124262180.0;
  let today = `${realNow - 3600000.0}`;
  let live: TriggerBotRow = {
    id: "b1", owner: "o1", kind: "telegram", name: "Support",
    workflowId: "w1", credentialRef: "telegram:b1", offset: "0",
    leaseBy: "", leaseUntil: "", enabled: true,
    runsToday: 3, dayStartedAt: today, lastAt: "", lastError: "",
    createdAt: "", updatedAt: "",
  };
  expect(mayRun(live, 0, realNow).ok);

  // The day still rolls over, and the count still climbs, at that clock.
  let counted = withRunCounted(live, realNow);
  expect(counted.runsToday == 4);
  expect(counted.dayStartedAt == today);

  let yesterday: TriggerBotRow = {
    id: live.id, owner: live.owner, kind: live.kind, name: live.name,
    workflowId: live.workflowId, credentialRef: live.credentialRef,
    offset: live.offset, leaseBy: live.leaseBy, leaseUntil: live.leaseUntil,
    enabled: true, runsToday: TRIGGER_RUNS_PER_DAY,
    dayStartedAt: `${realNow - 90000000.0}`,
    lastAt: "", lastError: "", createdAt: "", updatedAt: "",
  };
  expect(mayRun(yesterday, 0, realNow).ok);
  expect(withRunCounted(yesterday, realNow).runsToday == 1);
});

test("a chat's messages land in one conversation, not one each", () => {
  // Pure half only: the row carries the thread, so the lookup has something
  // to find. The query itself is exercised against a database by the run.
  let row = emptyMessage();
  expect(row.threadId == "");
  // A refused message never ran, so it never opened a conversation — and it
  // must not be mistaken for one when the next message looks for the chat's
  // thread. That is what the `thread_id <> ''` in threadForChat is for.
  expect(row.status == "");
});

test("the test window is a timestamp, so it cannot be forgotten on", () => {
  let realNow = 1786124262180.0;
  let b = bot();
  // No window: published. Inside one: draft. After it: published again,
  // enforced by comparison rather than by anything remembering to turn it
  // off — the property the whole feature hangs on.
  expect(!testingDraft(b, realNow));
  let open: TriggerBotRow = {
    id: b.id, owner: b.owner, kind: b.kind, name: b.name,
    workflowId: b.workflowId, credentialRef: b.credentialRef,
    offset: b.offset, leaseBy: b.leaseBy, leaseUntil: b.leaseUntil,
    enabled: b.enabled, runsToday: b.runsToday, dayStartedAt: b.dayStartedAt,
    lastAt: b.lastAt, lastError: b.lastError,
    draftUntil: `${realNow + 300000.0}`,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
  expect(testingDraft(open, realNow));
  expect(!testingDraft(open, realNow + 300001.0));
  // And counting a run keeps the window: the copy carries it.
  expect(testingDraft(withRunCounted(open, realNow), realNow));
});

test("options become a keyboard the phone can tap, and a blank set none", () => {
  let made = replyKeyboard("Log it\nSkip\n\n  ");
  expect(made.includes("\"keyboard\":[[{\"text\":\"Log it\"}],[{\"text\":\"Skip\"}]]"));
  // One-time: the buttons fold away after the tap rather than squatting on
  // every later message.
  expect(made.includes("\"one_time_keyboard\":true"));
  expect(replyKeyboard("") == "");
  expect(replyKeyboard("  \n ") == "");
});

test("a document rides in with its caption, and a bare file still speaks", () => {
  let withDoc = "{\"ok\":true,\"result\":[{\"update_id\":30,\"message\":{\"chat\":{\"id\":9,\"type\":\"private\"},"
    + "\"caption\":\"what is this contract about?\","
    + "\"document\":{\"file_id\":\"F123\",\"file_name\":\"contract.pdf\",\"file_size\":52000}}}]}";
  let seen = updatesIn(withDoc);
  expect(seen.length == 1);
  expect(seen[0].fileId == "F123");
  expect(seen[0].fileName == "contract.pdf");
  expect(seen[0].fileSize == 52000.0);
  expect(seen[0].text == "what is this contract about?");

  // No caption is not no message: the file IS the question.
  let bare = "{\"ok\":true,\"result\":[{\"update_id\":31,\"message\":{\"chat\":{\"id\":9,\"type\":\"private\"},"
    + "\"document\":{\"file_id\":\"F124\",\"file_name\":\"notes.txt\",\"file_size\":10}}}]}";
  let quiet = updatesIn(bare);
  expect(quiet.length == 1);
  expect(quiet[0].text == "");
  expect(quiet[0].fileId == "F124");

  // A photo stays stepped over — this slice is documents alone.
  let photo = "{\"ok\":true,\"result\":[{\"update_id\":32,\"message\":{\"chat\":{\"id\":9},\"photo\":[]}}]}";
  expect(updatesIn(photo).length == 0);
});

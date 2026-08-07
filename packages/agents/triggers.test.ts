// The parts of a trigger that can be wrong without a bot: what Telegram said,
// where the cursor goes next, and what a bot is allowed to cost.
//
// Everything here is pure, which is deliberate — the half that talks to
// Telegram is a poll and a POST, and the half that decides is this.
//
//   cd packages/agents && lumen test triggers.test.ts

import { TRIGGER_INPUT_MAX, TRIGGER_RUNS_PER_DAY, TRIGGER_RUNS_PER_MINUTE, TriggerBotRow, TriggerUpdate, emptyBot, mayRun, nextOffset, plainly, updatesIn, withRunCounted } from "./triggers.ts";

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

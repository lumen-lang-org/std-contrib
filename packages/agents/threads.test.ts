// Threads: what is replayed, what is trimmed, and what a person sees.
//
//   cd packages/agents && lumen test threads.test.ts

import { Turn, ToolCall, toolCall, userTurn, assistantTurn, toolTurn } from "./provider.ts";
import { withinBudget, nextRound, threadBudget } from "./threads.ts";

// A round: a question, an assistant turn that called a tool, the result, and
// the answer.
function round(question: string, callId: string, result: string, answer: string): Turn[] {
  let calls: ToolCall[] = [toolCall(callId, "warehouse_stock", "{}")];
  let none: ToolCall[] = [];
  let out: Turn[] = [
    userTurn(question),
    assistantTurn("", calls),
    toolTurn(callId, "warehouse_stock", result),
    assistantTurn(answer, none),
  ];
  return out;
}

function conversation(rounds: int): Turn[] {
  let out: Turn[] = [];
  let i: int = 0;
  while (i < rounds) {
    let r = round("question " + `${i}`, "c" + `${i}`, "result " + `${i}`, "answer " + `${i}`);
    let j: int = 0;
    while (j < r.length) { out.push(r[j]); j = j + 1; }
    i = i + 1;
  }
  return out;
}

test("a thread that fits is replayed whole", () => {
  let turns = conversation(3);
  expect(withinBudget(turns, 100000).length == turns.length);
});

test("trimming drops whole rounds, never half of one", () => {
  // The sharp edge: a tool turn whose assistant turn was dropped is a result
  // answering nothing, and every provider refuses the request. A thread that
  // grew too long would stop working rather than forget its beginning.
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept.length < turns.length);
  // Whatever survived starts a round: a user turn, not a tool result.
  expect(kept[0].role == "user");
  // And every tool turn still has an assistant turn before it.
  let i: int = 0;
  while (i < kept.length) {
    if (kept[i].role == "tool") { expect(i > 0 && kept[i - 1].role != "user"); }
    i = i + 1;
  }
});

test("the most recent round is the one kept", () => {
  // Forgetting the beginning is survivable; forgetting what was just said is
  // not what a continuing conversation means.
  let turns = conversation(4);
  let kept = withinBudget(turns, 60);
  expect(kept[0].text == "question 3" || kept[0].text == "question 2");
});

test("a round boundary is the next user turn", () => {
  let turns = conversation(2);
  // Round one is turns 0..3, so the next begins at 4.
  expect(nextRound(turns, 0) == 4);
  // Past the last round there is no next one.
  expect(nextRound(turns, 4) == turns.length);
});

test("a budget too small for even one round keeps that round rather than nothing", () => {
  // An empty replay would silently turn a thread into a series of unrelated
  // questions, which is worse than exceeding a budget by a little.
  let turns = conversation(2);
  let kept = withinBudget(turns, 1);
  expect(kept.length > 0);
  expect(kept[0].role == "user");
});

test("the budget is a number this package states", () => {
  expect(threadBudget() > 0);
});

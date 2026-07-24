// The spend guard.

import { makeBudget, unlimitedBudget, budgetIsLimited, budgetRemaining, budgetExhausted, messagesCost, chargeBudget, chargeMessages, budgetAllows, budgetAllowsMessages, budgetRefusal, chargeCall } from "./budget.ts";
import { systemMessage, userMessage } from "../core/messages.ts";

function twoMessages(): AiMessage[] {
  let ms: AiMessage[] = [
    systemMessage("You are concise."),
    userMessage("What is the capital of France?"),
  ];
  return ms;
}

test("a fresh budget has spent nothing", () => {
  let b = makeBudget(100);
  expect(b.limit == 100);
  expect(b.spent == 0);
  expect(b.calls == 0);
  expect(budgetRemaining(b) == 100);
  expect(!budgetExhausted(b));
});

test("a limit of zero or less means unlimited", () => {
  expect(!budgetIsLimited(makeBudget(0)));
  expect(!budgetIsLimited(makeBudget(-5)));
  expect(!budgetIsLimited(unlimitedBudget()));
  expect(budgetIsLimited(makeBudget(1)));
});

test("an unlimited budget allows any call and reports no remainder", () => {
  let b = unlimitedBudget();
  expect(budgetAllows(b, 1000000));
  expect(budgetRemaining(b) == -1);
  expect(!budgetExhausted(b));
});

test("charging accumulates and counts the call", () => {
  let b = chargeBudget(chargeBudget(makeBudget(100), 10), 15);
  expect(b.spent == 25);
  expect(b.calls == 2);
  expect(budgetRemaining(b) == 75);
});

test("charging never mutates the budget it was given", () => {
  let a = makeBudget(100);
  let b = chargeBudget(a, 40);
  expect(a.spent == 0);
  expect(b.spent == 40);
});

test("a negative charge counts as zero, not a refund", () => {
  let b = chargeBudget(makeBudget(100), -50);
  expect(b.spent == 0);
  expect(b.calls == 1);
});

test("a budget is exhausted once spending reaches the limit", () => {
  let b = chargeBudget(makeBudget(50), 50);
  expect(budgetExhausted(b));
  expect(budgetRemaining(b) == 0);
  expect(!budgetAllows(b, 1));
});

test("remaining never goes below zero even when overspent", () => {
  let b = chargeBudget(makeBudget(50), 500);
  expect(budgetRemaining(b) == 0);
  expect(budgetExhausted(b));
});

test("a call is refused whole rather than truncated", () => {
  // 40 spent of 50 leaves 10; a 20-token call does not fit and is not
  // partially allowed.
  let b = chargeBudget(makeBudget(50), 40);
  expect(!budgetAllows(b, 20));
  expect(budgetAllows(b, 10));
});

test("messages cost their content and their roles", () => {
  let cost = messagesCost(twoMessages());
  expect(cost > 0);
  let empty: AiMessage[] = [];
  expect(messagesCost(empty) == 0);
});

test("charging messages spends their estimated cost", () => {
  let ms = twoMessages();
  let b = chargeMessages(makeBudget(1000), ms);
  expect(b.spent == messagesCost(ms));
  expect(b.calls == 1);
});

test("allowing messages agrees with allowing their cost", () => {
  let ms = twoMessages();
  let tight = makeBudget(messagesCost(ms) - 1);
  let exact = makeBudget(messagesCost(ms));
  expect(!budgetAllowsMessages(tight, ms));
  expect(budgetAllowsMessages(exact, ms));
});

test("a refusal names the numbers, and there is none when the call fits", () => {
  let b = chargeBudget(makeBudget(50), 45);
  let why = budgetRefusal(b, 20);
  expect(why.indexOf("45") >= 0);
  expect(why.indexOf("50") >= 0);
  expect(why.indexOf("20") >= 0);
  expect(budgetRefusal(b, 1) == "");
});

// --- the explicit guard pattern ---------------------------------------------

test("charging a call counts the request and the reply", () => {
  let ms = twoMessages();
  let b = chargeCall(makeBudget(10000), ms, "a short answer");
  expect(b.spent > messagesCost(ms));
  expect(b.calls == 1);
});

test("a loop stops before the call that would overspend", () => {
  let ms = twoMessages();
  let reply = "this is a long answer that costs output tokens to produce";
  let b = makeBudget(messagesCost(ms) * 3);
  let sent: int = 0;
  let refused = "";
  let i: int = 0;
  while (i < 10) {
    if (!budgetAllowsMessages(b, ms)) {
      refused = budgetRefusal(b, messagesCost(ms));
      i = 10;
    } else {
      sent = sent + 1;
      b = chargeCall(b, ms, reply);
      i = i + 1;
    }
  }
  // It stopped on its own rather than running all ten.
  expect(sent > 0);
  expect(sent < 10);
  expect(refused.indexOf("budget exhausted") >= 0);
});

test("an unlimited budget never stops the loop", () => {
  let ms = twoMessages();
  let b = unlimitedBudget();
  let i: int = 0;
  while (i < 20) {
    expect(budgetAllowsMessages(b, ms));
    b = chargeCall(b, ms, "ok");
    i = i + 1;
  }
  expect(b.calls == 20);
  expect(b.spent > 0);
});

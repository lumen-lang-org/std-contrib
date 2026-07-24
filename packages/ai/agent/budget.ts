// A spend guard for a run.
//
// Every provider call costs money, and an agent loop makes as many as its
// stopping condition allows. `maxSteps` bounds tool dispatches, but nothing
// bounds tokens: a long conversation, a large retrieved context, or a model
// that answers at length can each cost far more than the step count suggests.
//
// A budget is a running total plus a ceiling. It is checked before a call and
// charged after one, so an over-budget run stops before spending rather than
// after noticing.
//
// Counts are estimates. There is no tokenizer here, so `estimateTokens`
// approximates at four characters per token — close enough to stop a runaway
// loop, not close enough to reconcile against an invoice.

import { estimateTokens } from "../memory/memory.ts";
import { AiMessage } from "../core/messages.ts";

// `limit` of 0 or less means unlimited, so a budget can be threaded through
// code that does not always want one.
export type AiBudget = {
  limit: int,
  spent: int,
  calls: int,
};

export function makeBudget(limit: int): AiBudget {
  let b: AiBudget = { limit: limit, spent: 0, calls: 0 };
  return b;
}

export function unlimitedBudget(): AiBudget {
  return makeBudget(0);
}

export function budgetIsLimited(b: AiBudget): bool {
  return b.limit > 0;
}

export function budgetRemaining(b: AiBudget): int {
  if (!budgetIsLimited(b)) { return -1; }
  let left = b.limit - b.spent;
  if (left < 0) { return 0; }
  return left;
}

export function budgetExhausted(b: AiBudget): bool {
  return budgetIsLimited(b) && b.spent >= b.limit;
}

// The tokens a set of messages will cost to send. Roles are counted too, since
// a long exchange of short turns still carries per-message overhead.
export function messagesCost(messages: AiMessage[]): int {
  let total: int = 0;
  let i: int = 0;
  while (i < messages.length) {
    total = total + estimateTokens(messages[i].content) + estimateTokens(messages[i].role);
    i = i + 1;
  }
  return total;
}

// Charge a call against the budget. Records are immutable, so this returns the
// new budget rather than updating in place.
export function chargeBudget(b: AiBudget, tokens: int): AiBudget {
  let charged: int = tokens;
  if (charged < 0) { charged = 0; }
  let out: AiBudget = {
    limit: b.limit,
    spent: b.spent + charged,
    calls: b.calls + 1,
  };
  return out;
}

export function chargeMessages(b: AiBudget, messages: AiMessage[]): AiBudget {
  return chargeBudget(b, messagesCost(messages));
}

// Whether a call of `tokens` fits. An unlimited budget always fits; a limited
// one must have room for the whole call, so a request is refused before it is
// sent rather than truncated part way.
export function budgetAllows(b: AiBudget, tokens: int): bool {
  if (!budgetIsLimited(b)) { return true; }
  return b.spent + tokens <= b.limit;
}

export function budgetAllowsMessages(b: AiBudget, messages: AiMessage[]): bool {
  return budgetAllows(b, messagesCost(messages));
}

// A human-readable reason to hand back when a call is refused, so a caller can
// report why a run stopped rather than inventing a message.
export function budgetRefusal(b: AiBudget, tokens: int): string {
  if (budgetAllows(b, tokens)) { return ""; }
  return "token budget exhausted: " + `${b.spent}` + " spent of " + `${b.limit}`
    + ", this call needs " + `${tokens}` + " more, after " + `${b.calls}` + " calls";
}

// Charge a completed call: the request that was sent and the reply that came
// back. Output tokens are usually the more expensive half, so a guard that
// counted only the request would undercount every call.
export function chargeCall(b: AiBudget, messages: AiMessage[], reply: string): AiBudget {
  return chargeBudget(b, messagesCost(messages) + estimateTokens(reply));
}

// There is deliberately no wrapper that takes a model and returns a guarded
// one. A closure here may read the values it captures but cannot call a
// function it received as a parameter, so the wrapper cannot be written; and a
// budget has to be rebound after every call anyway, since records are
// immutable. The explicit form is three lines and shows where the money goes:
//
//   if (!budgetAllowsMessages(b, msgs)) { return budgetRefusal(b, messagesCost(msgs)); }
//   let reply = model(msgs);
//   b = chargeCall(b, msgs, reply);

// Accessors, for reporting usage after a run.
export function budgetSpent(b: AiBudget): int {
  return b.spent;
}

export function budgetCalls(b: AiBudget): int {
  return b.calls;
}

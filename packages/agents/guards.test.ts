import { Request } from "../rest/server.ts";
import { sqlite } from "../plume/sqlite.ts";
import { ownedOrEmpty, roleAtLeast } from "./guards.ts";
import { guestTag } from "./api-core.ts";
import { OWNED_AGENT, OWNED_PROMPT, OWNED_SKILL, ownedRowsClause, owningTag, UNKNOWN_TAG } from "./owner.ts";

function withNoIdentity(): Request {
  let req: Request = {
    method: "GET", path: "/x", body: "",
    headers: new Map<string, string>(), params: new Map<string, string>(), query: new Map<string, string>(),
  };
  return req;
}

test("with no proxy telling this deployment who is asking, signed-in passes through - nothing is scoped, same as before the column existed", () => {
  let said = roleAtLeast(withNoIdentity(), "signed-in", "signing in is what makes this yours");
  expect(!said.rejected);
});

test("with no proxy telling this deployment who is asking, ownedOrEmpty resolves rather than emptying the list", () => {
  let said = ownedOrEmpty(withNoIdentity());
  expect(!said.rejected);
});

test("owner role still refuses a caller with no identity at all - unaffected by this fix, unlike signed-in and ownedOrEmpty", () => {
  let said = roleAtLeast(withNoIdentity(), "owner", "this needs an owner");
  expect(said.rejected);
});

test("guest-ok never refuses, whoever is asking", () => {
  let said = roleAtLeast(withNoIdentity(), "guest-ok", "unreachable");
  expect(!said.rejected);
});

test("owningTag answers empty two different ways - no tag at all, or one blank tag", () => {
  let none: string[] = [];
  expect(owningTag(none) == "");
  let blank: string[] = [""];
  expect(owningTag(blank) == "");
  let real: string[] = ["u1"];
  expect(owningTag(real) == "u1");
  let unreadable: string[] = [UNKNOWN_TAG];
  expect(owningTag(unreadable) == UNKNOWN_TAG);
});

test("tags.length > 0 is what tells the two empty-owningTag cases apart - a trusted proxy naming nobody, not proxy trust being off", () => {
  let noProxyTrust: string[] = [];
  expect(owningTag(noProxyTrust) == "" && noProxyTrust.length == 0);
  let trustedButBlank: string[] = [""];
  expect(owningTag(trustedButBlank) == "" && trustedButBlank.length > 0);
});

test("an unreadable tag is a real, non-empty tag - the guard has to name it, not just check for empty", () => {
  let unreadable: string[] = [UNKNOWN_TAG];
  expect(owningTag(unreadable) != "");
  expect(owningTag(unreadable) == UNKNOWN_TAG);
});

test("guestTag only matches a single tag that says guest:", () => {
  let guest: string[] = ["guest:abc123"];
  expect(guestTag(guest) == "guest:abc123");
  let real: string[] = ["u1"];
  expect(guestTag(real) == "");
  let none: string[] = [];
  expect(guestTag(none) == "");
});

test("a row with no owner is the deployment's, and everybody reads it", () => {
  // The clause is what agents, prompts and skills are listed through, so the
  // shape of it is the whole of who sees what.
  let clause = ownedRowsClause(sqlite(), OWNED_AGENT, 1);
  expect(clause.indexOf("id NOT IN") >= 0);
  expect(clause.indexOf("kind = 'agent'") >= 0);
  expect(clause.indexOf("owner = ") >= 0);
});

test("a kind is spelled into the clause and never taken from a caller", () => {
  // Three constants, and no route hands this a string of its own.
  expect(OWNED_AGENT == "agent");
  expect(OWNED_PROMPT == "prompt");
  expect(OWNED_SKILL == "skill");
});

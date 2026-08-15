import { Request } from "../rest/server.ts";
import { ownedOrEmpty, roleAtLeast } from "./guards.ts";
import { guestTag } from "./api-core.ts";
import { owningTag, UNKNOWN_TAG } from "./owner.ts";

function withNoIdentity(): Request {
  let req: Request = {
    method: "GET", path: "/x", body: "",
    headers: new Map<string, string>(), params: new Map<string, string>(), query: new Map<string, string>(),
  };
  return req;
}

test("a caller with no identity at all is refused as signed-in, not waved through", () => {
  let said = roleAtLeast(withNoIdentity(), "signed-in", "signing in is what makes this yours");
  expect(said.rejected);
  expect(said.reply.status == 400);
});

test("a caller with no identity at all sees an empty list, not everyone's rows", () => {
  let said = ownedOrEmpty(withNoIdentity());
  expect(said.rejected);
  expect(said.reply.body == "[]");
});

test("owner role still refuses a caller with no identity at all", () => {
  let said = roleAtLeast(withNoIdentity(), "owner", "this needs an owner");
  expect(said.rejected);
});

test("guest-ok never refuses, whoever is asking", () => {
  let said = roleAtLeast(withNoIdentity(), "guest-ok", "unreachable");
  expect(!said.rejected);
});

test("owningTag answers empty only for an empty tag list", () => {
  let none: string[] = [];
  expect(owningTag(none) == "");
  let real: string[] = ["u1"];
  expect(owningTag(real) == "u1");
  let unreadable: string[] = [UNKNOWN_TAG];
  expect(owningTag(unreadable) == UNKNOWN_TAG);
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

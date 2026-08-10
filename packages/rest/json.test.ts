import { okJson, createdJson, jsonOf } from "./server.ts";

type Banner = { text: string };
type Flags = { enabled: bool, configured: bool };

test("okJson stringifies a record once, in one place", () => {
  let b: Banner = { text: "a \"quoted\" banner" };
  let r = okJson(b);
  expect(r.status == 200);
  expect(r.body == "{\"text\":\"a \\\"quoted\\\" banner\"}");
  expect((r.headers.get("content-type") ?? "") == "application/json");
});

test("booleans and arrays come out as JSON, not as strings", () => {
  let f: Flags = { enabled: true, configured: false };
  expect(okJson(f).body == "{\"enabled\":true,\"configured\":false}");
  let rows: Banner[] = [{ text: "a" }, { text: "b" }];
  expect(okJson(rows).body == "[{\"text\":\"a\"},{\"text\":\"b\"}]");
});

test("createdJson and jsonOf carry the status", () => {
  let b: Banner = { text: "x" };
  expect(createdJson(b).status == 201);
  expect(jsonOf(202, b).status == 202);
});

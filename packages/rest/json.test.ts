import { OkJson, CreatedJson, JsonOf } from "./server.ts";

type Banner = { text: string };
type Flags = { enabled: bool, configured: bool };

test("okJson stringifies a record once, in one place", () => {
  let b: Banner = { text: "a \"quoted\" banner" };
  let r = OkJson(b);
  expect(r.status == 200);
  expect(r.body == "{\"text\":\"a \\\"quoted\\\" banner\"}");
  expect((r.headers.get("content-type") ?? "") == "application/json");
});

test("booleans and arrays come out as JSON, not as strings", () => {
  let f: Flags = { enabled: true, configured: false };
  expect(OkJson(f).body == "{\"enabled\":true,\"configured\":false}");
  let rows: Banner[] = [{ text: "a" }, { text: "b" }];
  expect(OkJson(rows).body == "[{\"text\":\"a\"},{\"text\":\"b\"}]");
});

test("createdJson and jsonOf carry the status", () => {
  let b: Banner = { text: "x" };
  expect(CreatedJson(b).status == 201);
  expect(JsonOf(202, b).status == 202);
});

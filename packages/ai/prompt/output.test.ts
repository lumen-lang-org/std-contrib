// Tests for output.

import { parseChoiceOutput } from "./output.ts";

test("parseChoice tolerates real model phrasing", () => {
  let choices: string[] = ["compiled", "interpreted"];
  expect(parseChoiceOutput("compiled", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Compiled", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Compiled.", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Lumen is compiled.", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("  INTERPRETED  ", choices, "unknown") == "interpreted");
  expect(parseChoiceOutput("neither, really", choices, "unknown") == "unknown");
});

test("parseChoice does not match a choice inside a longer word", () => {
  let yn: string[] = ["yes", "no"];
  // "no" must not match inside "know"
  expect(parseChoiceOutput("I don't know", yn, "unknown") == "unknown");
  expect(parseChoiceOutput("No.", yn, "unknown") == "no");
  expect(parseChoiceOutput("nobody", yn, "unknown") == "unknown");
});

test("parseChoice prefers the longer overlapping choice", () => {
  let opts: string[] = ["yes", "yes always"];
  expect(parseChoiceOutput("yes always", opts, "unknown") == "yes always");
  expect(parseChoiceOutput("yes", opts, "unknown") == "yes");
});

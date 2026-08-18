import { bytesCap, artifactBytesMax, runsPerOwnerDay, threadBytesMax, uploadBytesMax } from "./caps.ts";

test("a number is taken, surrounding space and all", () => {
  expect(bytesCap("4096", 10) == 4096);
  expect(bytesCap("  4096  ", 10) == 4096);
});

test("anything unreadable is the default, never a refusal to start", () => {
  expect(bytesCap("", 10) == 10);
  expect(bytesCap("   ", 10) == 10);
  expect(bytesCap("512MB", 10) == 10);
  expect(bytesCap("half a gig", 10) == 10);
});

test("zero and below are a typo, not a policy", () => {
  expect(bytesCap("0", 10) == 10);
  expect(bytesCap("-1", 10) == 10);
});

test("with nothing set every cap is the number this shipped with", () => {
  expect(artifactBytesMax() == 524288);
  expect(threadBytesMax() == 104857600);
  expect(uploadBytesMax() == 1048576);
  expect(runsPerOwnerDay() == 200);
});

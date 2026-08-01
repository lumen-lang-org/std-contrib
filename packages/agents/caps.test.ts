// The ceilings: what an operator can say, and what they get for saying
// nothing.
//
// A Lumen process reads its environment and cannot write it, so what is asked
// here is the parser — every string a unit file can hand it — plus the one
// fact that matters most and is easiest to break silently: with nothing set,
// each cap is still the number this shipped with.
//
//   cd packages/agents && lumen test caps.test.ts

import { bytesCap, artifactBytesMax, threadBytesMax, uploadBytesMax } from "./caps.ts";

test("a number is taken, surrounding space and all", () => {
  expect(bytesCap("4096", 10) == 4096);
  // `export $(grep -v "^#" .env | xargs)` is how the unit reads these, and a
  // value that came through a shell arrives with whatever the shell left on it.
  expect(bytesCap("  4096  ", 10) == 4096);
});

test("anything unreadable is the default, never a refusal to start", () => {
  // This is read while the module initialises: there is no logger yet and no
  // exit code worth anything, so a typo leaves the engine at its documented
  // default instead of dead.
  expect(bytesCap("", 10) == 10);
  expect(bytesCap("   ", 10) == 10);
  expect(bytesCap("512MB", 10) == 10);
  expect(bytesCap("half a gig", 10) == 10);
});

test("zero and below are a typo, not a policy", () => {
  // "0" reads as "nothing may ever be written", which is a way to brick a
  // deployment by shell quoting. No operator means it.
  expect(bytesCap("0", 10) == 10);
  expect(bytesCap("-1", 10) == 10);
});

test("with nothing set every cap is the number this shipped with", () => {
  // The whole contract of moving these off compile-time constants: a
  // deployment that sets none of them is bit-for-bit what it was.
  expect(artifactBytesMax() == 524288);
  expect(threadBytesMax() == 104857600);
  expect(uploadBytesMax() == 1048576);
});

// The binding, against the zone database this machine has.
//
//   cd packages/cron && ./build.sh && lumen test cron.test.ts
//
// Every assertion is written in civil time rather than epoch milliseconds: a
// failure that reads `expected 1774850400000, got 1774846800000` says nothing,
// and this package exists precisely to get one hour right.
//
// The instants are all 2026, after the last release of tzdata this was written
// against. A zone whose rules change (they do — Egypt, Chile, Iran, Lebanon
// have all moved in the last few years) can turn one of these red without
// anything here being wrong; the fix then is to update the expectation, not the
// package.

import { next, previous, civil, offsetMinutes, fault, knownZone } from "./cron.ts";

// Saturday 2026-03-28T12:00:00Z. Chosen because the weekend forces the
// day-of-week arithmetic to skip Sunday, and because it sits two days before
// Europe's spring-forward — so the same constant serves both kinds of test.
const SAT: i64 = 1774699200000;

test("the next weekday morning, in the zone the person lives in", () => {
  let paris = next("Europe/Paris", "0 0 8 * * 1-5", SAT);
  expect(paris.ok);
  expect(civil("Europe/Paris", paris.at) == "2026-03-30 08:00:00 CEST");

  // The same expression, a different zone, a different instant. If these two
  // came back equal the zone argument would be decorative.
  let tokyo = next("Asia/Tokyo", "0 0 8 * * 1-5", SAT);
  expect(tokyo.ok);
  expect(civil("Asia/Tokyo", tokyo.at) == "2026-03-30 08:00:00 JST");
  expect(paris.at != tokyo.at);
});

test("Sunday is skipped rather than fired on", () => {
  let fire = next("UTC", "0 0 8 * * 1-5", SAT);
  expect(civil("UTC", fire.at) == "2026-03-30 08:00:00 UTC");
});

test("an hourly step lands on the step, not an hour later", () => {
  let fire = next("UTC", "0 */15 * * * *", SAT);
  expect(civil("UTC", fire.at) == "2026-03-28 12:15:00 UTC");
});

test("the clocks going forward eat a run, and this is the run they eat", () => {
  // Paris jumps 02:00 -> 03:00 on 2026-03-29, so 02:30 does not exist that
  // night. This answers the 30th rather than firing at 03:30 on the 29th.
  //
  // That is a decision, not a discovery: a task at 02:30 daily loses one run a
  // year. It is asserted here so that changing it is a deliberate act with a
  // red test in front of it, rather than something a library upgrade does
  // quietly.
  let fire = next("Europe/Paris", "0 30 2 * * *", SAT);
  expect(fire.ok);
  expect(civil("Europe/Paris", fire.at) == "2026-03-30 02:30:00 CEST");
});

test("the offset moves with the date, which is the whole point", () => {
  // Before and after the 29th, when Paris moves. The "before" side has to come
  // from `previous`: the next 08:00 after Saturday noon is Sunday the 29th,
  // which is already past that morning's jump and therefore already CEST.
  let winter = previous("Europe/Paris", "0 0 8 * * 1-5", SAT);    // 27 March, CET
  let summer = next("Europe/Paris", "0 0 8 * * 1-5", SAT);        // 30 March, CEST
  expect(offsetMinutes("Europe/Paris", winter.at) == 60);
  expect(offsetMinutes("Europe/Paris", summer.at) == 120);

  // A zone with a half-hour offset and no DST at all — the case that catches
  // an implementation storing offsets in whole hours.
  expect(offsetMinutes("Asia/Kolkata", SAT) == 330);
});

test("the previous firing, for deciding what a restart missed", () => {
  let back = previous("Europe/Paris", "0 0 8 * * 1-5", SAT);
  expect(back.ok);
  expect(civil("Europe/Paris", back.at) == "2026-03-27 08:00:00 CET");
});

test("a schedule that cannot be read says so, and answers no time", () => {
  expect(fault("0 0 8 * * 1-5") == "");

  // Five fields is the everyday cron dialect and it is refused, deliberately:
  // read as six it would mean something entirely different and run every eight
  // seconds.
  expect(fault("0 8 * * 1-5") != "");
  expect(fault("") != "");
  expect(fault("nonsense") != "");

  let fire = next("UTC", "nonsense", SAT);
  expect(!fire.ok);
  expect(fire.at == -1);
  expect(fire.error != "");
});

test("a zone the machine does not have is refused, not silently made UTC", () => {
  expect(knownZone("Europe/Paris"));
  expect(knownZone("UTC"));
  expect(!knownZone("Mars/Olympus"));
  expect(!knownZone(""));
  // The name arrives from a form, so it is also a path.
  expect(!knownZone("../../etc/passwd"));
});

test("a call leaves the process's own zone where it found it", () => {
  // The shim installs TZ for the length of a call. If it failed to put it back,
  // every later call — and everything else in the process that formats a time —
  // would quietly move to the last zone anyone asked about.
  let before = civil("Asia/Tokyo", SAT);
  let elsewhere = next("America/New_York", "0 0 8 * * 1-5", SAT);
  expect(elsewhere.ok);
  let after = civil("Asia/Tokyo", SAT);
  expect(before == after);
});

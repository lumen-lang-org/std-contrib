// Live token streaming.
//
// Each line prints the moment its piece of the answer arrives, with the
// milliseconds elapsed since the request went out. Watching those numbers climb
// is the point: a buffered call would print every line at once, at the end.
// The same call also returns the assembled reply.
//
// Run:
//   export MISTRAL_API_KEY="..."
//   # or put MISTRAL_API_KEY=... in .env
//   lumen compile packages/ai/examples/mistral-stream.ts
//   ./mistral-stream

import { modelConfig, withTemperature, streamChat, modelEndpoint, system, user } from "../ai.ts";
import { requireEnv } from "./env.ts";

let apiKey = requireEnv("MISTRAL_API_KEY");

let mistral = withTemperature(
  modelConfig("mistral", "mistral-large-latest", apiKey),
  0.3,
);

console.log(`streaming from ${mistral.model} at ${modelEndpoint(mistral)}`);

let start = time.monotonic();

// A handler assigned to a function type may read the variables it closes over
// but not reassign them, so the running totals live in a map, whose contents it
// may change.
let stats = new Map<string, i64>();
stats.set("deltas", 0);
stats.set("firstAt", -1);

let onEvent: StreamHandler = (event: StreamEvent): void => {
  let at = time.monotonic() - start;
  if (event.kind == "delta") {
    let n = stats.get("deltas") ?? 0;
    stats.set("deltas", n + 1);
    if ((stats.get("firstAt") ?? -1) < 0) { stats.set("firstAt", at); }
    console.log(`+${at}ms ${event.delta}`);
  }
  if (event.kind == "error") {
    console.error(`stream error: ${event.raw}`);
  }
};

let result = streamChat(mistral, [
  system("You are concise."),
  user("Name the planets of the solar system, one per line."),
], onEvent);

console.log("---");
// The first token landing well before the last is what separates a stream from
// a buffered call that happens to be quick.
console.log(`first token after ${stats.get("firstAt") ?? -1}ms`);
console.log(`${stats.get("deltas") ?? 0} deltas over ${time.monotonic() - start}ms`);
console.log(`status ${result.status}, ${result.content.length} characters assembled`);

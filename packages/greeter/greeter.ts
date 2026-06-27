// Demonstrates a multi-file remote package: greeter imports a sibling module
// (./shout.ts) which is fetched recursively relative to this file's URL.
import shout from "./shout.ts";

export default function greeter(name: string): string {
  return shout("Hey " + name);
}

test "shouts a greeting" {
  expect(greeter("Lumen")).toBe("Hey Lumen!!!");
}

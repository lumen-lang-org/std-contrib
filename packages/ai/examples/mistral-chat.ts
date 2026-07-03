// Live Mistral chat example.
//
// Run:
//   export MISTRAL_API_KEY="..."
//   # or create .env with MISTRAL_API_KEY=...
//   lumen compile packages/ai/examples/mistral-chat.ts
//   ./mistral-chat

import { chatMistral, system, user } from "../ai.ts";
import { get as getEnvValue } from "../../dotenv/dotenv.ts";

function readMistralKey(): string {
  let fromEnv = process.env("MISTRAL_API_KEY") ?? "";
  if (fromEnv != "") { return fromEnv; }

  let rootEnv = fs.readFileSync(".env");
  let fromRoot = getEnvValue(rootEnv, "MISTRAL_API_KEY", "");
  if (fromRoot != "") { return fromRoot; }

  let exampleEnv = fs.readFileSync("packages/ai/examples/.env");
  return getEnvValue(exampleEnv, "MISTRAL_API_KEY", "");
}

let apiKey = readMistralKey();

if (apiKey == "") {
  console.error("Set MISTRAL_API_KEY in the shell or in a local .env file.");
  process.exit(1);
}

let result = chatMistral(apiKey, "mistral-large-latest", [
  system("You are concise."),
  user("Reply with exactly: lumen ok"),
]);

console.log(result.status);
console.log(result.content);

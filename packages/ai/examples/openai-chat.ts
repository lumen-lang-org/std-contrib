// Live OpenAI-compatible chat example.
//
// Run:
//   export OPENAI_API_KEY="..."
//   # or create .env with OPENAI_API_KEY=...
//   lumen compile packages/ai/examples/openai-chat.ts
//   ./openai-chat

import { chatOpenAI, system, user } from "../ai.ts";
import { get as getEnvValue } from "../../dotenv/dotenv.ts";

function readOpenAIKey(): string {
  let fromEnv = process.env("OPENAI_API_KEY") ?? "";
  if (fromEnv != "") { return fromEnv; }

  let rootEnv = fs.readFileSync(".env");
  let fromRoot = getEnvValue(rootEnv, "OPENAI_API_KEY", "");
  if (fromRoot != "") { return fromRoot; }

  let exampleEnv = fs.readFileSync("packages/ai/examples/.env");
  return getEnvValue(exampleEnv, "OPENAI_API_KEY", "");
}

let apiKey = readOpenAIKey();

if (apiKey == "") {
  console.error("Set OPENAI_API_KEY in the shell or in a local .env file.");
  process.exit(1);
}

let result = chatOpenAI(apiKey, "gpt-4.1-mini", [
  system("You are concise."),
  user("Reply with exactly: lumen ok"),
]);

console.log(result.status);
console.log(result.content);

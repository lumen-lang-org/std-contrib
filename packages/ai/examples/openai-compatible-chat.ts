// Live OpenAI-compatible local gateway example.
//
// Run with a compatible local server such as an Ollama/OpenAI-style gateway:
//   export OPENAI_COMPATIBLE_BASE_URL="http://localhost:11434/v1"
//   export OPENAI_COMPATIBLE_MODEL="llama3.2"
//   export OPENAI_COMPATIBLE_API_KEY="local"
//   lumen compile packages/ai/examples/openai-compatible-chat.ts
//   ./openai-compatible-chat

import { chatOpenAIWithBaseUrl, system, user } from "../ai.ts";
import { get as getEnvValue } from "../../dotenv/dotenv.ts";

function readConfig(key: string, fallback: string): string {
  let fromEnv = process.env(key) ?? "";
  if (fromEnv != "") { return fromEnv; }

  let rootEnv = fs.readFileSync(".env");
  let fromRoot = getEnvValue(rootEnv, key, "");
  if (fromRoot != "") { return fromRoot; }

  let exampleEnv = fs.readFileSync("packages/ai/examples/.env");
  return getEnvValue(exampleEnv, key, fallback);
}

let baseUrl = readConfig("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:11434/v1");
let model = readConfig("OPENAI_COMPATIBLE_MODEL", "llama3.2");
let apiKey = readConfig("OPENAI_COMPATIBLE_API_KEY", "local");

let result = chatOpenAIWithBaseUrl(baseUrl, apiKey, model, [
  system("You are concise."),
  user("Reply with exactly: lumen ok"),
]);

console.log(result.status);
console.log(result.content);

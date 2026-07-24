// Live OpenAI-compatible chat example, driven by a model config.
//
// Run:
//   export OPENAI_API_KEY="..."
//   # or put OPENAI_API_KEY=... in .env
//   lumen compile packages/ai/examples/openai-chat.ts
//   ./openai-chat

import { modelConfig, chat, modelEndpoint, system, user } from "../ai.ts";
import { requireEnv } from "./env.ts";

let apiKey = requireEnv("OPENAI_API_KEY");
let openai = modelConfig("openai", "gpt-4.1-mini", apiKey);

console.log(`calling ${openai.model} at ${modelEndpoint(openai)}`);

let result = chat(openai, [
  system("You are concise."),
  user("Reply with exactly: lumen ok"),
]);

console.log(result.status);
console.log(result.content);

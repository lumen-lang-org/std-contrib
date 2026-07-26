// Live OpenAI-compatible local gateway example.
//
// Run with a compatible local server such as an Ollama/OpenAI-style gateway:
//   export OPENAI_COMPATIBLE_BASE_URL="http://localhost:11434/v1"
//   export OPENAI_COMPATIBLE_MODEL="llama3.2"
//   export OPENAI_COMPATIBLE_API_KEY="local"
//   lumen compile packages/ai/examples/openai-compatible-chat.ts
//   ./openai-compatible-chat

import { chatOpenAI, system, user } from "../ai.ts";
import { envValueOr } from "./env.ts";


let baseUrl = envValueOr("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:11434/v1");
let model = envValueOr("OPENAI_COMPATIBLE_MODEL", "llama3.2");
let apiKey = envValueOr("OPENAI_COMPATIBLE_API_KEY", "local");

let result = chatOpenAI({
  apiKey: apiKey,
  model: model,
  baseUrl: baseUrl,
  messages: [
    system("You are concise."),
    user("Reply with exactly: lumen ok"),
  ],
});

console.log(result.status);
console.log(result.content);

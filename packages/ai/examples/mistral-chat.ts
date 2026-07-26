// Live Mistral chat example, driven by a model config.
//
// The config carries the provider, model name, credential and generation
// options in one value, so the call names a model instead of threading
// arguments — and unlike chatMistral it can actually set temperature.
//
// Run:
//   export MISTRAL_API_KEY="..."
//   # or put MISTRAL_API_KEY=... in .env
//   lumen compile packages/ai/examples/mistral-chat.ts
//   ./mistral-chat

import { modelConfig, withTemperature, chat, modelEndpoint, system, user } from "../ai.ts";
import { requireEnv } from "./env.ts";

let apiKey = requireEnv("MISTRAL_API_KEY");

let mistral = withTemperature(
  modelConfig({ provider: "mistral", model: "mistral-large-latest", apiKey: apiKey }),
  0.2,
);

console.log(`calling ${mistral.model} at ${modelEndpoint(mistral)} (temperature ${mistral.temperature})`);

let result = chat(mistral, [
  system("You are concise."),
  user("Reply with exactly: lumen ok"),
]);

console.log(result.status);
console.log(result.content);

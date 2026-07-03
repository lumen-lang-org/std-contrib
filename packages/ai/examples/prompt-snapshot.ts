// Deterministic prompt snapshot example.
//
// Run:
//   lumen compile packages/ai/examples/prompt-snapshot.ts
//   ./prompt-snapshot

import { chatPromptContent, chatPromptRole, renderChatPrompt } from "../ai.ts";

let entries = renderChatPrompt(
  ["system", "user"],
  ["You are {{tone}}.", "Explain {{topic}} in one sentence."],
  ["tone", "topic"],
  ["concise", "Lumen"],
);

for (const entry of entries) {
  console.log(chatPromptRole(entry) + ": " + chatPromptContent(entry));
}

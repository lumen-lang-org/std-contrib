// Deterministic prompt snapshot example.
//
// Run:
//   lumen compile packages/ai/examples/prompt-snapshot.ts
//   ./prompt-snapshot

import { chatPromptContent, chatPromptRole, renderChatPrompt, promptPart, templateVar } from "../ai.ts";

let entries = renderChatPrompt(
  [
    promptPart("system", "You are {{tone}}."),
    promptPart("user", "Explain {{topic}} in one sentence."),
  ],
  [
    templateVar("tone", "concise"),
    templateVar("topic", "Lumen"),
  ],
);

for (const entry of entries) {
  console.log(chatPromptRole(entry) + ": " + chatPromptContent(entry));
}

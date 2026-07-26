// Deterministic prompt snapshot example.
//
// Run:
//   lumen compile packages/ai/examples/prompt-snapshot.ts
//   ./prompt-snapshot

import { chatPromptContent, chatPromptRole, renderChatPrompt } from "../ai.ts";

let entries = renderChatPrompt(
  [
    { role: "system", template: "You are {{tone}}." },
    { role: "user", template: "Explain {{topic}} in one sentence." },
  ],
  [
    { name: "tone", value: "concise" },
    { name: "topic", value: "Lumen" },
  ],
);

for (const entry of entries) {
  console.log(chatPromptRole(entry) + ": " + chatPromptContent(entry));
}

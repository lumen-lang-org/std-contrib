// Support agent — an end-to-end, fully offline example.
//
// Ties together four parts of the ai package with no API key and no network:
//   1. RAG      — retrieve the relevant doc passage for a question
//   2. Tools    — expose that lookup as a tool the agent can call
//   3. Agent    — a tool-calling loop, driven here by a scripted fake model
//   4. Memory   — keep the conversation and persist it to disk
//
// A real deployment swaps `fakeModel(script)` for `openAIAgent(key, model, tools)`
// or `mistralAgent(...)` — the loop and everything else stay identical.
//
// Run:
//   lumen compile packages/ai/examples/support-agent/main.ts
//   ./main

import { defineTool, toolRegistry, registerTool, runAgent, fakeModel, fakeToolCall, agentTrace, agentSystemPrompt, system, user, appendMessage, transcript, saveHistory, loadHistory } from "../../ai.ts";
import { lookupDocs } from "./knowledge.ts";

// 1 + 2. A tool the agent can call. Its body runs the keyword RAG lookup over
// the knowledge base and returns a cited passage.
function searchDocsBody(question: string): string {
  return lookupDocs(question);
}

function buildTools() {
  let tools = toolRegistry();
  tools = registerTool(tools, defineTool(
    "search_docs",
    "Search the Lumen product documentation for a passage that answers a question.",
    "a natural-language question",
    searchDocsBody,
  ));
  return tools;
}

function main(): void {
  let tools = buildTools();

  // 3. The agent's opening history: a system prompt that lists the tools, then
  // the user's question.
  let history = appendMessage([], system(agentSystemPrompt(tools, "You are a Lumen support assistant. Answer only from the docs.")));
  history = appendMessage(history, user("Does Lumen need a garbage collector, and how do I install it?"));

  // The scripted model: first turn asks to call search_docs, then (after seeing
  // the tool result) the loop stops with the model's final answer "done".
  // Swap this one line for openAIAgent(...) to run against a real provider.
  let script: string[] = [fakeToolCall("search_docs", "garbage collector install")];
  let result = runAgent(fakeModel(script), tools, history, 5);

  console.log("=== agent run ===");
  console.log(`stop reason: ${result.stopReason}`);
  console.log(`steps: ${result.stepCount}`);
  console.log(agentTrace(result));
  console.log(`answer: ${result.answer}`);

  // 4. Record the exchange in conversation memory and persist it, so a later
  // session can resume with loadHistory.
  let convo = appendMessage(history, system("(tool) " + result.answer));
  let path = "/tmp/support-agent-history.json";
  saveHistory(path, convo);
  let restored = loadHistory(path);

  console.log("");
  console.log("=== persisted conversation ===");
  console.log(`saved ${convo.length} messages, restored ${restored.length}`);
  console.log(transcript(restored));
}

main();

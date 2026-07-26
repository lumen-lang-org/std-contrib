// Every public record type, annotated by name.
//
// This file exists to prove the barrel exports them: a caller importing ai.ts
// by URL gets no name leaking in from module inlining, so if any of these is
// missing from ai.ts the file will not compile.
import { Message, Result, ProviderError, ChatRequest, ModelOptions, TokenUsage, ModelConfig, ModelSpec, Document, Chunk, LoadResult, SearchHit, VectorStore, Tool, ToolResult, ToolCall, ChatTurn, Model, AgentStep, AgentResult, SubAgent, Budget, ApprovalRun, CheckpointStore, SchemaField, Structured, TemplateVar, ChatPromptPart, Summarizer, StreamEvent, StreamHandler, McpTool, McpResult, McpStdioSession, ChatCall, system, user, modelConfig, vectorStore, unlimitedBudget, memoryCheckpointStore } from "../ai.ts";

function main(): void {
  let msg: Message = system("You are concise.");
  let cfg: ModelConfig = modelConfig({ provider: "mistral", model: "m", apiKey: "k" });
  let spec: ModelSpec = { provider: "openai", model: "gpt-4o", apiKey: "k" };
  let call: ChatCall = { apiKey: "k", model: "m", baseUrl: "", messages: [user("hi")] };
  let vars: TemplateVar[] = [{ name: "topic", value: "native compilation" }];
  let parts: ChatPromptPart[] = [{ role: "system", template: "You are {{tone}}." }];
  let store: VectorStore = vectorStore();
  let budget: Budget = unlimitedBudget();
  let checkpoints: CheckpointStore = memoryCheckpointStore();

  console.log(msg.role + " " + cfg.provider + " " + spec.model + " " + call.model);
  console.log(`${vars.length}` + " " + `${parts.length}` + " " + `${store.docs.length}`);
  console.log(`${budget.limit}` + " " + `${budget.calls}` + " " + `${checkpoints.has("k")}`);
}
main();

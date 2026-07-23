// ai -- small typed AI helpers for OpenAI-compatible chat APIs.
//
// Public barrel for the package. Implementation is split across focused
// modules so future agents, tools, and retrieval pieces have room to grow.
// Run: lumen test packages/ai/ai.ts

import { systemMessage, userMessage, assistantMessage } from "./messages.ts";
import { renderPromptTemplate, missingTemplateVariables as readMissingTemplateVariables, unusedTemplateVariables as readUnusedTemplateVariables, renderChatPrompt as renderFlatChatPrompt, chatPromptRole as readChatPromptRole, chatPromptContent as readChatPromptContent } from "./prompt.ts";
import { buildChatRequest } from "./request.ts";
import { makeAiResult } from "./result.ts";
import { makeProviderError } from "./error.ts";
import { makeModelOptions, defaultModelOptions as makeDefaultModelOptions } from "./options.ts";
import { buildProviderChatBody } from "./provider.ts";
import { parseTextOutput as readTextOutput, parseLineOutput as readLineOutput, parseStringListOutput as readStringListOutput, parseChoiceOutput as readChoiceOutput, firstFencedBlockOutput as readFirstFencedBlockOutput, firstJsonObjectOutput as readFirstJsonObjectOutput, typedJsonInputOutput as readTypedJsonInputOutput, retryPromptOutput as buildRetryPromptOutput } from "./output.ts";
import { makeAuthHeaders, runOpenAIChat, runOpenAIChatWithBaseUrl, buildOpenAIChatBody, buildOpenAIChatBodyWithStops, readOpenAIContent, readOpenAIResult, readOpenAIError, readOpenAITokenUsage } from "./openai.ts";
import { makeMistralAuthHeaders, runMistralChat, runMistralChatWithBaseUrl, buildMistralChatBody, buildMistralChatBodyWithStops, readMistralContent, readMistralResult, readMistralError, readMistralTokenUsage } from "./mistral.ts";
// Names a sibling module imports (cosineSimilarity, fakeEmbedding,
// makeDocument, withMetadata, documentMetadata, emptyVectorStore,
// addDocuments, searchByText) are imported here WITHOUT an alias: module
// inlining renames the definition itself, so aliasing one of them would break
// the sibling that imports it under its original name.
import { dotProduct as computeDotProduct, vectorNorm as computeVectorNorm, normalizeVector as computeNormalizeVector, cosineSimilarity, euclideanDistance as computeEuclideanDistance, fakeEmbedding } from "./vector.ts";
import { makeDocument, documentMetadata, withMetadata, splitFixed as splitFixedText, splitRecursive as splitRecursiveText, splitParagraphs as splitParagraphText, splitToDocuments as splitTextToDocuments } from "./document.ts";
import { embeddingBody as buildEmbeddingBody, embeddingBodyBatch as buildEmbeddingBodyBatch, parseEmbeddingResponse as readEmbeddingResponse, parseEmbeddingBatch as readEmbeddingBatch, embedOpenAI as runEmbedOpenAI, embedOpenAIWithBaseUrl as runEmbedOpenAIWithBaseUrl, embedMistral as runEmbedMistral } from "./embed.ts";
import { emptyVectorStore, storeSize as readStoreSize, addVector as addStoreVector, addDocuments, deleteById as deleteStoreDocument, filterByMetadata as filterStoreByMetadata, searchByVector as runSearchByVector, searchByText } from "./store.ts";
import { tokenizeQuery as readQueryTerms, keywordScore as computeKeywordScore, keywordRetrieve as runKeywordRetrieve, vectorRetrieve as runVectorRetrieve, hybridRetrieve as runHybridRetrieve, formatContext as buildRagContext, ragPrompt as buildRagPrompt, ragMessages as buildRagMessages } from "./retrieve.ts";
import { appendMessage as pushHistoryMessage, windowMemory as applyWindowMemory, charBudgetMemory as applyCharBudgetMemory, estimateTokens as computeEstimateTokens, historyChars as computeHistoryChars, renderTranscript as buildTranscript, summaryPrompt as buildSummaryPrompt, applySummary as buildSummaryHistory, setMemoryValue as writeMemoryValue, getMemoryValue as readMemoryValue, serializeHistory as writeHistoryJson, parseHistory as readHistoryJson, saveHistory as writeHistoryFile, loadHistory as readHistoryFile } from "./memory.ts";
// Same rule for the tool and agent layers: toolcall.ts imports makeTool, and
// agent.ts imports makeTool, describeTools, runToolWithPolicy,
// toolResultMessage, parseToolCalls, toolCallInput, makeToolCall and
// toolCallArgument. Those eight names are imported here WITHOUT an alias, so
// their public wrappers below take a different name rather than renaming the
// definition out from under a sibling.
import { makeTool, describeTools, runToolWithPolicy, toolResultMessage, toolRegistry as emptyToolRegistry, registerTool as addToolEntry, findTool as findToolIndex, hasTool as hasToolNamed, toolNames as readToolNames, runTool as dispatchTool } from "./tools.ts";
import { makeToolCall, toolCallArgument, toolCallInput, parseToolCalls, serializeToolDefs as buildToolDefs, serializeToolDefsMistral as buildToolDefsMistral, parseMistralToolCalls as readMistralToolCalls, hasToolCalls as responseHasToolCalls, finishReason as readFinishReason } from "./toolcall.ts";
import { runAgent as runAgentLoop, runAgentWithPolicy as runAgentLoopWithPolicy, agentSystemPrompt as buildAgentSystemPrompt, agentTrace as renderAgentTrace, makeAgentStep as buildAgentStep, fakeModel as makeFakeModel, agentFakeAnswer as buildFakeAnswer, agentFakeToolCall as buildFakeToolCall, openAIAgentModel as makeOpenAIAgentModel, mistralAgentModel as makeMistralAgentModel, agentHistoryToTurns as buildAgentTurns } from "./agent.ts";
// toolchat.ts is already inlined through agent.ts (which imports several of its
// functions), so its exports are in scope under their ORIGINAL names. Importing
// them here under an alias would not bind — the module was inlined once already.
// So every toolchat name is imported unaliased, exactly like the sibling-shared
// vector/tool names above, and the public wrappers below take a different name.
import { buildOpenAIToolBody, buildMistralToolBody, runOpenAIToolChat, runMistralToolChat } from "./toolchat.ts";

type JsonName = {
  name: string,
};

export function system(content: string): LumenAiMessage {
  return systemMessage(content);
}

export function user(content: string): LumenAiMessage {
  return userMessage(content);
}

export function assistant(content: string): LumenAiMessage {
  return assistantMessage(content);
}

export function renderTemplate(template: string, keys: string[], values: string[]): string {
  return renderPromptTemplate(template, keys, values);
}

export function partialTemplate(template: string, keys: string[], values: string[]): string {
  return renderPromptTemplate(template, keys, values);
}

export function missingVariables(template: string, keys: string[]): string[] {
  return readMissingTemplateVariables(template, keys);
}

export function unusedVariables(template: string, keys: string[]): string[] {
  return readUnusedTemplateVariables(template, keys);
}

export function systemTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return system(renderPromptTemplate(template, keys, values));
}

export function userTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return user(renderPromptTemplate(template, keys, values));
}

export function assistantTemplate(template: string, keys: string[], values: string[]): LumenAiMessage {
  return assistant(renderPromptTemplate(template, keys, values));
}

export function renderChatPrompt(roles: string[], templates: string[], keys: string[], values: string[]): string[] {
  return renderFlatChatPrompt(roles, templates, keys, values);
}

export function chatPromptRole(entry: string): string {
  return readChatPromptRole(entry);
}

export function chatPromptContent(entry: string): string {
  return readChatPromptContent(entry);
}

export function chatRequest(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): LumenAiChatRequest {
  return buildChatRequest(provider, model, messages, temperature, maxTokens);
}

export function aiResult(status: int, ok: bool, content: string, raw: string): LumenAiResult {
  return makeAiResult(status, ok, content, raw);
}

export function providerError(provider: string, status: int, message: string, raw: string): LumenAiProviderError {
  return makeProviderError(provider, status, message, raw);
}

export function modelOptions(temperature: number, maxTokens: int): LumenAiModelOptions {
  return makeModelOptions(temperature, maxTokens);
}

export function defaultModelOptions(): LumenAiModelOptions {
  return makeDefaultModelOptions();
}

export function providerChatBody(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildProviderChatBody(provider, model, messages, temperature, maxTokens);
}

export function parseText(raw: string): string {
  return readTextOutput(raw);
}

export function parseLines(raw: string): string[] {
  return readLineOutput(raw);
}

export function parseStringList(raw: string): string[] {
  return readStringListOutput(raw);
}

export function parseChoice(raw: string, choices: string[], fallback: string): string {
  return readChoiceOutput(raw, choices, fallback);
}

export function firstFencedBlock(raw: string): string {
  return readFirstFencedBlockOutput(raw);
}

export function firstJsonObject(raw: string): string {
  return readFirstJsonObjectOutput(raw);
}

export function typedJsonInput(raw: string): string {
  return readTypedJsonInputOutput(raw);
}

export function retryPrompt(instruction: string, invalidOutput: string, errorMessage: string): string {
  return buildRetryPromptOutput(instruction, invalidOutput, errorMessage);
}

export function openAIChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildOpenAIChatBody(model, messages, temperature, maxTokens);
}

export function openAIChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
  return buildOpenAIChatBodyWithStops(model, messages, temperature, maxTokens, stop);
}

export function authHeaders(apiKey: string): Map<string, string> {
  return makeAuthHeaders(apiKey);
}

export function mistralAuthHeaders(apiKey: string): Map<string, string> {
  return makeMistralAuthHeaders(apiKey);
}

export function parseOpenAIContent(raw: string): string {
  return readOpenAIContent(raw);
}

export function parseOpenAIResult(status: int, ok: bool, raw: string): LumenAiResult {
  return readOpenAIResult(status, ok, raw);
}

export function parseOpenAIError(status: int, raw: string): LumenAiProviderError {
  return readOpenAIError(status, raw);
}

export function parseOpenAITokenUsage(raw: string): LumenAiTokenUsage {
  return readOpenAITokenUsage(raw);
}

export function chatOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatOpenAI(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runOpenAIChat(apiKey, model, messages);
}

export function mistralChatBody(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  return buildMistralChatBody(model, messages, temperature, maxTokens);
}

export function mistralChatBodyWithStops(model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
  return buildMistralChatBodyWithStops(model, messages, temperature, maxTokens, stop);
}

export function parseMistralContent(raw: string): string {
  return readMistralContent(raw);
}

export function parseMistralResult(status: int, ok: bool, raw: string): LumenAiResult {
  return readMistralResult(status, ok, raw);
}

export function parseMistralError(status: int, raw: string): LumenAiProviderError {
  return readMistralError(status, raw);
}

export function parseMistralTokenUsage(raw: string): LumenAiTokenUsage {
  return readMistralTokenUsage(raw);
}

export function chatMistralWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runMistralChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatMistral(apiKey: string, model: string, messages: LumenAiMessage[]): LumenAiResult {
  return runMistralChat(apiKey, model, messages);
}

export function document(id: string, text: string, source: string, metadata: string): LumenAiDocument {
  return makeDocument(id, text, source, metadata);
}

export function docMetadata(doc: LumenAiDocument, key: string): string {
  return documentMetadata(doc, key);
}

export function withDocMetadata(doc: LumenAiDocument, key: string, value: string): LumenAiDocument {
  return withMetadata(doc, key, value);
}

export function splitText(text: string, size: int, overlap: int): string[] {
  return splitFixedText(text, size, overlap);
}

export function splitTextRecursive(text: string, size: int, overlap: int): string[] {
  return splitRecursiveText(text, size, overlap);
}

export function splitParagraphs(text: string): string[] {
  return splitParagraphText(text);
}

export function splitDocuments(text: string, source: string, size: int, overlap: int): LumenAiDocument[] {
  return splitTextToDocuments(text, source, size, overlap);
}

export function dot(a: number[], b: number[]): number {
  return computeDotProduct(a, b);
}

export function norm(v: number[]): number {
  return computeVectorNorm(v);
}

export function normalize(v: number[]): number[] {
  return computeNormalizeVector(v);
}

export function cosine(a: number[], b: number[]): number {
  return cosineSimilarity(a, b);
}

export function distance(a: number[], b: number[]): number {
  return computeEuclideanDistance(a, b);
}

// Offline, deterministic, dependency-free embedder. Hashing bag of words, so
// use at least 64 dimensions and prefer a real provider embedding in
// production.
export function hashEmbedding(text: string, dims: int): number[] {
  return fakeEmbedding(text, dims);
}

export function embeddingBody(model: string, input: string): string {
  return buildEmbeddingBody(model, input);
}

export function embeddingBodyBatch(model: string, inputs: string[]): string {
  return buildEmbeddingBodyBatch(model, inputs);
}

export function parseEmbedding(raw: string): number[] {
  return readEmbeddingResponse(raw);
}

export function parseEmbeddingBatch(raw: string): number[][] {
  return readEmbeddingBatch(raw);
}

export function embedText(apiKey: string, model: string, input: string): number[] {
  return runEmbedOpenAI(apiKey, model, input);
}

export function embedTextWithBaseUrl(baseUrl: string, apiKey: string, model: string, input: string): number[] {
  return runEmbedOpenAIWithBaseUrl(baseUrl, apiKey, model, input);
}

export function embedMistral(apiKey: string, model: string, input: string): number[] {
  return runEmbedMistral(apiKey, model, input);
}

export function vectorStore(): LumenAiVectorStore {
  return emptyVectorStore();
}

export function storeSize(store: LumenAiVectorStore): int {
  return readStoreSize(store);
}

export function addVector(store: LumenAiVectorStore, doc: LumenAiDocument, vector: number[]): LumenAiVectorStore {
  return addStoreVector(store, doc, vector);
}

export function addDocs(store: LumenAiVectorStore, docs: LumenAiDocument[], dims: int): LumenAiVectorStore {
  return addDocuments(store, docs, dims);
}

export function deleteDoc(store: LumenAiVectorStore, id: string): LumenAiVectorStore {
  return deleteStoreDocument(store, id);
}

export function filterDocs(store: LumenAiVectorStore, key: string, value: string): LumenAiVectorStore {
  return filterStoreByMetadata(store, key, value);
}

export function searchVector(store: LumenAiVectorStore, query: number[], k: int): LumenAiSearchHit[] {
  return runSearchByVector(store, query, k);
}

export function search(store: LumenAiVectorStore, query: string, dims: int, k: int): LumenAiSearchHit[] {
  return searchByText(store, query, dims, k);
}

export function queryTerms(text: string): string[] {
  return readQueryTerms(text);
}

export function keywordScore(doc: LumenAiDocument, terms: string[]): number {
  return computeKeywordScore(doc, terms);
}

export function keywordRetrieve(docs: LumenAiDocument[], query: string, k: int): LumenAiSearchHit[] {
  return runKeywordRetrieve(docs, query, k);
}

export function vectorRetrieve(store: LumenAiVectorStore, query: string, dims: int, k: int): LumenAiSearchHit[] {
  return runVectorRetrieve(store, query, dims, k);
}

export function retrieve(store: LumenAiVectorStore, docs: LumenAiDocument[], query: string, dims: int, k: int): LumenAiSearchHit[] {
  return runHybridRetrieve(store, docs, query, dims, k);
}

export function formatContext(hits: LumenAiSearchHit[]): string {
  return buildRagContext(hits);
}

export function ragPrompt(question: string, hits: LumenAiSearchHit[]): string {
  return buildRagPrompt(question, hits);
}

export function ragMessages(question: string, hits: LumenAiSearchHit[]): LumenAiMessage[] {
  return buildRagMessages(question, hits);
}

export function appendMessage(history: LumenAiMessage[], msg: LumenAiMessage): LumenAiMessage[] {
  return pushHistoryMessage(history, msg);
}

export function windowMemory(history: LumenAiMessage[], turns: int): LumenAiMessage[] {
  return applyWindowMemory(history, turns);
}

export function budgetMemory(history: LumenAiMessage[], maxChars: int): LumenAiMessage[] {
  return applyCharBudgetMemory(history, maxChars);
}

export function estimateTokens(text: string): int {
  return computeEstimateTokens(text);
}

export function historyChars(history: LumenAiMessage[]): int {
  return computeHistoryChars(history);
}

export function transcript(history: LumenAiMessage[]): string {
  return buildTranscript(history);
}

export function summaryPrompt(history: LumenAiMessage[], priorSummary: string): string {
  return buildSummaryPrompt(history, priorSummary);
}

export function applySummary(summary: string, recent: LumenAiMessage[]): LumenAiMessage[] {
  return buildSummaryHistory(summary, recent);
}

export function remember(store: string, key: string, value: string): string {
  return writeMemoryValue(store, key, value);
}

export function recall(store: string, key: string): string {
  return readMemoryValue(store, key);
}

export function serializeHistory(history: LumenAiMessage[]): string {
  return writeHistoryJson(history);
}

export function parseHistory(raw: string): LumenAiMessage[] {
  return readHistoryJson(raw);
}

export function saveHistory(path: string, history: LumenAiMessage[]): void {
  writeHistoryFile(path, history);
}

export function loadHistory(path: string): LumenAiMessage[] {
  return readHistoryFile(path);
}

// A tool is a name, a description the model reads, a one-line note about the
// input, and a function from one string to one string. V1 tools take and return
// text; a tool body must not throw, so report trouble by returning it.
export function defineTool(name: string, description: string, params: string, run: (input: string) => string): LumenAiTool {
  return makeTool(name, description, params, run);
}

export function toolRegistry(): LumenAiTool[] {
  return emptyToolRegistry();
}

export function registerTool(tools: LumenAiTool[], entry: LumenAiTool): LumenAiTool[] {
  return addToolEntry(tools, entry);
}

export function findTool(tools: LumenAiTool[], name: string): int {
  return findToolIndex(tools, name);
}

export function hasTool(tools: LumenAiTool[], name: string): bool {
  return hasToolNamed(tools, name);
}

export function toolNames(tools: LumenAiTool[]): string[] {
  return readToolNames(tools);
}

export function toolDescriptions(tools: LumenAiTool[]): string {
  return describeTools(tools);
}

export function runTool(tools: LumenAiTool[], name: string, input: string): LumenAiToolResult {
  return dispatchTool(tools, name, input);
}

// Deny wins over allow, and an empty allow list means everything not denied.
export function runToolGuarded(tools: LumenAiTool[], allow: string[], deny: string[], name: string, input: string): LumenAiToolResult {
  return runToolWithPolicy(tools, allow, deny, name, input);
}

export function toolMessage(result: LumenAiToolResult): LumenAiMessage {
  return toolResultMessage(result);
}

export function toolCall(id: string, name: string, args: string): LumenAiToolCall {
  return makeToolCall(id, name, args);
}

export function toolCalls(raw: string): LumenAiToolCall[] {
  return parseToolCalls(raw);
}

export function parseMistralToolCalls(raw: string): LumenAiToolCall[] {
  return readMistralToolCalls(raw);
}

export function toolCallArg(call: LumenAiToolCall, key: string): string {
  return toolCallArgument(call, key);
}

export function toolInput(call: LumenAiToolCall): string {
  return toolCallInput(call);
}

export function hasToolCalls(raw: string): bool {
  return responseHasToolCalls(raw);
}

export function finishReason(raw: string): string {
  return readFinishReason(raw);
}

export function serializeToolDefs(tools: LumenAiTool[]): string {
  return buildToolDefs(tools);
}

export function serializeToolDefsMistral(tools: LumenAiTool[]): string {
  return buildToolDefsMistral(tools);
}

export function agentStep(index: int, name: string, input: string, output: string, ok: bool): LumenAiAgentStep {
  return buildAgentStep(index, name, input, output, ok);
}

export function agentSystemPrompt(tools: LumenAiTool[], instruction: string): string {
  return buildAgentSystemPrompt(tools, instruction);
}

// One step is one model call plus every tool call it asked for, so `maxSteps`
// bounds model calls and the loop terminates even against a model that asks for
// a tool forever.
export function runAgent(model: LumenAiModel, tools: LumenAiTool[], history: LumenAiMessage[], maxSteps: int): LumenAiAgentResult {
  return runAgentLoop(model, tools, history, maxSteps);
}

export function runAgentWithPolicy(model: LumenAiModel, tools: LumenAiTool[], allow: string[], deny: string[], history: LumenAiMessage[], maxSteps: int): LumenAiAgentResult {
  return runAgentLoopWithPolicy(model, tools, allow, deny, history, maxSteps);
}

export function agentTrace(result: LumenAiAgentResult): string {
  return renderAgentTrace(result);
}

// Offline model driver for tests and examples: it replays canned provider
// bodies in order, then answers "done". Start a fake run from a system/user
// history, because the turn is counted off the assistant messages already in
// the conversation.
export function fakeModel(responses: string[]): LumenAiModel {
  return makeFakeModel(responses);
}

export function fakeAnswer(text: string): string {
  return buildFakeAnswer(text);
}

export function fakeToolCall(name: string, input: string): string {
  return buildFakeToolCall(name, input);
}

// A live OpenAI-compatible model for runAgent. The returned closure carries the
// serialized tool definitions in every request and handles the native tool_calls
// / tool_call_id round trip, so `runAgent(openAIAgent(key, model, tools), tools,
// history, maxSteps)` drives a real provider with no change to the loop.
export function openAIAgent(apiKey: string, model: string, tools: LumenAiTool[]): LumenAiModel {
  return makeOpenAIAgentModel(apiKey, model, tools);
}

export function mistralAgent(apiKey: string, model: string, tools: LumenAiTool[]): LumenAiModel {
  return makeMistralAgentModel(apiKey, model, tools);
}

// Rebuild the native turn history (with native tool_calls and tool_call_id) that
// a live tool round trip needs from the loop's provider-neutral message history.
export function agentChatTurns(messages: LumenAiMessage[]): LumenAiChatTurn[] {
  return buildAgentTurns(messages);
}

// Build a tool-enabled chat request body from native turns: the serialized tool
// definitions ride in the `tools` field, dropped entirely when the registry is
// empty.
export function openAIToolBody(model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[], temperature: number, maxTokens: int): string {
  return buildOpenAIToolBody(model, turns, tools, temperature, maxTokens);
}

export function mistralToolBody(model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[], temperature: number, maxTokens: int): string {
  return buildMistralToolBody(model, turns, tools, temperature, maxTokens);
}

// One tool-enabled round trip: POST the native turns plus tool definitions and
// return the raw response body for parseToolCalls / finishReason to read.
export function toolChatOpenAI(apiKey: string, model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[]): string {
  return runOpenAIToolChat(apiKey, model, turns, tools);
}

export function toolChatMistral(apiKey: string, model: string, turns: LumenAiChatTurn[], tools: LumenAiTool[]): string {
  return runMistralToolChat(apiKey, model, turns, tools);
}

test("message helpers", () => {
  let s = system("You are concise.");
  let u = user("Hello");
  let a = assistant("Hi");
  expect(s.role == "system");
  expect(s.content == "You are concise.");
  expect(u.role == "user");
  expect(a.role == "assistant");
});

test("render template", () => {
  let out = renderTemplate(
    "Write a {{tone}} note to {{name}}. {{tone}} matters.",
    ["tone", "name"],
    ["short", "Aymen"],
  );
  expect(out == "Write a short note to Aymen. short matters.");
});

test("missing variables", () => {
  let missing = missingVariables("Hello {{name}} from {{place}} and {{name}}", ["name"]);
  expect(missing.length == 1);
  expect(missing[0] == "place");
});

test("unused variables", () => {
  let unused = unusedVariables("Hello {{name}}", ["name", "place", "tone", "place"]);
  expect(unused.length == 2);
  expect(unused[0] == "place");
  expect(unused[1] == "tone");
});

test("partial template", () => {
  let out = partialTemplate("Hello {{name}} from {{place}}", ["name"], ["Aymen"]);
  expect(out == "Hello Aymen from {{place}}");
});

test("render chat prompt", () => {
  let entries = renderChatPrompt(
    ["system", "user"],
    ["You are {{tone}}.", "Explain {{topic}}."],
    ["tone", "topic"],
    ["concise", "Lumen"],
  );
  expect(entries.length == 2);
  expect(chatPromptRole(entries[0]) == "system");
  expect(chatPromptContent(entries[0]) == "You are concise.");
  expect(chatPromptRole(entries[1]) == "user");
  expect(chatPromptContent(entries[1]) == "Explain Lumen.");
});

test("message templates", () => {
  let s = systemTemplate("You are {{tone}}.", ["tone"], ["brief"]);
  let u = userTemplate("Explain {{topic}}.", ["topic"], ["Lumen"]);
  let a = assistantTemplate("Answer: {{answer}}", ["answer"], ["ok"]);
  expect(s.role == "system");
  expect(s.content == "You are brief.");
  expect(u.role == "user");
  expect(u.content == "Explain Lumen.");
  expect(a.role == "assistant");
  expect(a.content == "Answer: ok");
});

test("provider-neutral chat request", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let req = chatRequest("mistral", "mistral-large-latest", messages, 0.3, 128);
  expect(req.provider == "mistral");
  expect(req.model == "mistral-large-latest");
  expect(req.messages.length == 2);
  expect(req.messages[1].content == "Say hi");
  expect(req.max_tokens == 128);
});

test("provider-neutral result", () => {
  let result = aiResult(200, true, "ok", "{\"content\":\"ok\"}");
  expect(result.status == 200);
  expect(result.ok);
  expect(result.content == "ok");
  expect(result.raw.includes("content"));
});

test("provider-neutral error", () => {
  let err = providerError("mistral", 401, "Unauthorized", "{\"detail\":\"Unauthorized\"}");
  expect(err.provider == "mistral");
  expect(err.status == 401);
  expect(err.message == "Unauthorized");
  expect(err.raw.includes("Unauthorized"));
});

test("model options", () => {
  let opts = modelOptions(0.4, 256);
  expect(opts.max_tokens == 256);
  let defaults = defaultModelOptions();
  expect(defaults.max_tokens == 1024);
});

test("provider chat body selector", () => {
  let messages = [user("Say hi")];
  let openaiBody = providerChatBody("openai-compatible", "local-model", messages, 0.1, 16);
  let mistralBody = providerChatBody("mistral", "mistral-large-latest", messages, 0.1, 16);
  let missingBody = providerChatBody("unknown", "x", messages, 0.1, 16);
  expect(openaiBody.includes("\"model\":\"local-model\""));
  expect(mistralBody.includes("\"model\":\"mistral-large-latest\""));
  expect(missingBody == "");
});

test("parse text output", () => {
  expect(parseText("hello") == "hello");
});

test("parse line output", () => {
  let lines = parseLines("a\nb\nc");
  expect(lines.length == 3);
  expect(lines[1] == "b");
  let empty = parseLines("");
  expect(empty.length == 0);
});

test("parse string list output", () => {
  let items = parseStringList("- alpha\n* beta\n3. gamma\nplain\n");
  expect(items.length == 4);
  expect(items[0] == "alpha");
  expect(items[1] == "beta");
  expect(items[2] == "gamma");
  expect(items[3] == "plain");
});

test("parse choice output", () => {
  expect(parseChoice(" yes ", ["yes", "no"], "unknown") == "yes");
  expect(parseChoice("maybe", ["yes", "no"], "unknown") == "unknown");
});

test("first fenced block output", () => {
  let block = firstFencedBlock("before\n```json\n{\"ok\":true}\n```\nafter");
  expect(block == "{\"ok\":true}");
  expect(firstFencedBlock("no fence") == "");
});

test("first json object output", () => {
  let json = firstJsonObject("prefix {\"a\":{\"b\":\"}\"}} suffix");
  expect(json == "{\"a\":{\"b\":\"}\"}}");
  expect(firstJsonObject("no object") == "");
});

test("typed json input output", () => {
  let json = typedJsonInput("answer:\n```json\n{\"name\":\"Ada\"}\n```");
  const parsed: JsonName = JSON.parse<JsonName>(json);
  expect(parsed.name == "Ada");
});

test("retry prompt output", () => {
  let prompt = retryPrompt("Return JSON.", "nope", "missing object");
  expect(prompt.includes("Return JSON."));
  expect(prompt.includes("nope"));
  expect(prompt.includes("missing object"));
  expect(prompt.includes("Return only corrected output."));
});

test("openai request body", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let body = openAIChatBody("gpt-test", messages, 0.2, 64);
  expect(body.includes("\"model\":\"gpt-test\""));
  expect(body.includes("\"role\":\"system\""));
  expect(body.includes("\"content\":\"Say hi\""));
  expect(body.includes("\"temperature\":2e-1") || body.includes("\"temperature\":0.2"));
  expect(body.includes("\"max_tokens\":64"));
  let stopped = openAIChatBodyWithStops("gpt-test", messages, 0.2, 64, ["END"]);
  expect(stopped.includes("\"stop\":[\"END\"]"));
});

test("auth headers", () => {
  let headers = authHeaders("sk-test");
  expect((headers.get("Content-Type") ?? "") == "application/json");
  expect((headers.get("Authorization") ?? "") == "Bearer sk-test");
  let mistralHeaders = mistralAuthHeaders("mk-test");
  expect((mistralHeaders.get("Content-Type") ?? "") == "application/json");
  expect((mistralHeaders.get("Authorization") ?? "") == "Bearer mk-test");
});

test("parse openai content", () => {
  let raw = "{\"id\":\"chatcmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Hello from Lumen\"},\"finish_reason\":\"stop\"}]}";
  expect(parseOpenAIContent(raw) == "Hello from Lumen");
  let result = parseOpenAIResult(200, true, raw);
  expect(result.ok);
  expect(result.status == 200);
  expect(result.content == "Hello from Lumen");
});

test("parse openai error", () => {
  let raw = "{\"error\":{\"message\":\"Invalid API key\",\"type\":\"auth_error\",\"code\":\"invalid_api_key\"}}";
  let err = parseOpenAIError(401, raw);
  expect(err.provider == "openai");
  expect(err.status == 401);
  expect(err.message == "Invalid API key");
});

test("parse openai token usage", () => {
  let raw = "{\"id\":\"chatcmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"gpt-test\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14},\"choices\":[]}";
  let usage = parseOpenAITokenUsage(raw);
  expect(usage.prompt_tokens == 10);
  expect(usage.completion_tokens == 4);
  expect(usage.total_tokens == 14);
});

test("malformed response returns empty content", () => {
  expect(parseOpenAIContent("not json") == "");
});

test("mistral request body", () => {
  let messages = [system("You are helpful."), user("Say hi")];
  let body = mistralChatBody("mistral-large-latest", messages, 0.1, 32);
  expect(body.includes("\"model\":\"mistral-large-latest\""));
  expect(body.includes("\"role\":\"user\""));
  expect(body.includes("\"content\":\"Say hi\""));
  expect(body.includes("\"max_tokens\":32"));
  let stopped = mistralChatBodyWithStops("mistral-large-latest", messages, 0.1, 32, ["DONE"]);
  expect(stopped.includes("\"stop\":[\"DONE\"]"));
});

test("parse mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"object\":\"chat.completion\",\"created\":1,\"model\":\"mistral-large-latest\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"Bonjour from Mistral\"},\"finish_reason\":\"stop\"}]}";
  expect(parseMistralContent(raw) == "Bonjour from Mistral");
  let result = parseMistralResult(200, true, raw);
  expect(result.ok);
  expect(result.status == 200);
  expect(result.content == "Bonjour from Mistral");
});

test("parse mistral error", () => {
  let raw = "{\"detail\":\"Unauthorized\"}";
  let err = parseMistralError(401, raw);
  expect(err.provider == "mistral");
  expect(err.status == 401);
  expect(err.message == "Unauthorized");
});

test("parse mistral token usage", () => {
  let raw = "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"usage\":{\"prompt_tokens\":15,\"total_tokens\":19,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":0}},\"object\":\"chat.completion\",\"choices\":[]}";
  let usage = parseMistralTokenUsage(raw);
  expect(usage.prompt_tokens == 15);
  expect(usage.completion_tokens == 4);
  expect(usage.total_tokens == 19);
});

test("parse live-shaped mistral content", () => {
  let raw = "{\"id\":\"cmpl-test\",\"created\":1,\"model\":\"mistral-large-latest\",\"usage\":{\"prompt_tokens\":15,\"total_tokens\":19,\"completion_tokens\":4},\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":\"lumen ok\"}}]}";
  expect(parseMistralContent(raw) == "lumen ok");
});

function barrelCorpus(): LumenAiDocument[] {
  let out: LumenAiDocument[] = [
    document("lumen", "lumen compiles to a native binary with no runtime", "langs.md", "topic\tlangs"),
    document("python", "python runs on an interpreter and ships a large standard library", "langs.md", "topic\tlangs"),
    document("bread", "sourdough bread needs a starter, flour, water and salt", "recipes.md", "topic\tfood"),
  ];
  return out;
}

test("document helpers through the barrel", () => {
  let doc = document("d1", "hello", "notes.md", "");
  expect(doc.id == "d1");
  expect(doc.source == "notes.md");
  let tagged = withDocMetadata(doc, "topic", "greeting");
  expect(docMetadata(tagged, "topic") == "greeting");
  expect(docMetadata(doc, "topic") == "");
});

test("splitters through the barrel", () => {
  let chunks = splitText("abcdefgh", 3, 1);
  expect(chunks.length > 1);
  expect(chunks[0] == "abc");
  let recursive = splitTextRecursive("one two three four five six", 12, 0);
  expect(recursive.length > 1);
  let paragraphs = splitParagraphs("first block\n\nsecond block");
  expect(paragraphs.length == 2);
  expect(paragraphs[1] == "second block");
  let docs = splitDocuments("abcdefgh", "notes.md", 4, 0);
  expect(docs.length == 2);
  expect(docs[0].source == "notes.md");
  expect(docs[0].text == "abcd");
});

test("vector maths through the barrel", () => {
  let a: number[] = [3.0, 4.0];
  let b: number[] = [3.0, 4.0];
  expect(dot(a, b) == 25.0);
  expect(norm(a) == 5.0);
  expect(cosine(a, b) > 0.999);
  expect(distance(a, b) == 0.0);
  let unit = normalize(a);
  expect(unit[0] > 0.59 && unit[0] < 0.61);
});

test("hash embedding through the barrel", () => {
  let one = hashEmbedding("native binary compiler", 64);
  let same = hashEmbedding("native binary compiler", 64);
  let other = hashEmbedding("sourdough bread starter", 64);
  expect(one.length == 64);
  expect(cosine(one, same) > 0.999);
  expect(cosine(one, other) < cosine(one, same));
});

test("embedding bodies and parsing through the barrel", () => {
  let body = embeddingBody("text-embedding-3-small", "hello");
  expect(body.includes("\"model\":\"text-embedding-3-small\""));
  expect(body.includes("\"input\":\"hello\""));
  let batch = embeddingBodyBatch("text-embedding-3-small", ["a", "b"]);
  expect(batch.includes("\"input\":[\"a\",\"b\"]"));
  let vector = parseEmbedding("{\"object\":\"list\",\"data\":[{\"object\":\"embedding\",\"index\":0,\"embedding\":[0.5,-0.25]}],\"model\":\"m\"}");
  expect(vector.length == 2);
  expect(vector[0] == 0.5);
  let many = parseEmbeddingBatch("{\"data\":[{\"embedding\":[1.0,0.0]},{\"embedding\":[0.0,1.0]}]}");
  expect(many.length == 2);
  expect(many[1][1] == 1.0);
  expect(parseEmbedding("not json").length == 0);
});

test("vector store through the barrel", () => {
  let store = addDocs(vectorStore(), barrelCorpus(), 64);
  expect(storeSize(store) == 3);
  let hits = search(store, "native binary", 64, 2);
  expect(hits.length == 2);
  expect(hits[0].doc.id == "lumen");
  let smaller = deleteDoc(store, "bread");
  expect(storeSize(smaller) == 2);
  expect(storeSize(store) == 3);
  let food = filterDocs(store, "topic", "food");
  expect(storeSize(food) == 1);
  expect(food.docs[0].id == "bread");
});

test("manual vector insertion through the barrel", () => {
  let store = addVector(vectorStore(), document("v1", "x", "mem", ""), [1.0, 0.0]);
  store = addVector(store, document("v2", "y", "mem", ""), [0.0, 1.0]);
  let hits = searchVector(store, [1.0, 0.0], 1);
  expect(hits.length == 1);
  expect(hits[0].doc.id == "v1");
  expect(hits[0].score > 0.999);
});

test("retrieval through the barrel", () => {
  let docs = barrelCorpus();
  let store = addDocs(vectorStore(), docs, 64);
  let terms = queryTerms("Which language compiles to a native binary?");
  expect(terms.length == 7);
  expect(terms[0] == "which");
  expect(keywordScore(docs[0], terms) > keywordScore(docs[2], terms));
  let keyword = keywordRetrieve(docs, "native binary runtime", 2);
  expect(keyword[0].doc.id == "lumen");
  let vectorHits = vectorRetrieve(store, "native binary runtime", 64, 2);
  expect(vectorHits[0].doc.id == "lumen");
  let hybrid = retrieve(store, docs, "native binary runtime", 64, 2);
  expect(hybrid[0].doc.id == "lumen");
  expect(keywordRetrieve(docs, "", 2).length == 0);
});

test("rag prompt through the barrel", () => {
  let docs = barrelCorpus();
  let store = addDocs(vectorStore(), docs, 64);
  let hits = retrieve(store, docs, "native binary runtime", 64, 1);
  let context = formatContext(hits);
  expect(context.includes("[1] (langs.md)"));
  expect(context.includes("native binary"));
  let prompt = ragPrompt("Does lumen need a runtime?", hits);
  expect(prompt.includes("Context:"));
  expect(prompt.includes("Does lumen need a runtime?"));
  expect(prompt.includes("The context does not contain the answer."));
  let messages = ragMessages("Does lumen need a runtime?", hits);
  expect(messages.length == 2);
  expect(messages[0].role == "system");
  expect(messages[1].role == "user");
  expect(messages[1].content == "Does lumen need a runtime?");
  let emptyPrompt = ragPrompt("anything", keywordRetrieve(docs, "", 3));
  expect(emptyPrompt.includes("(no context available)"));
});

test("conversation memory through the barrel", () => {
  let history: LumenAiMessage[] = [system("You are concise.")];
  history = appendMessage(history, user("Hi"));
  history = appendMessage(history, assistant("Hello"));
  history = appendMessage(history, user("What is Lumen?"));
  expect(history.length == 4);
  let windowed = windowMemory(history, 2);
  expect(windowed.length == 3);
  expect(windowed[0].role == "system");
  expect(windowed[2].content == "What is Lumen?");
  let budgeted = budgetMemory(history, 20);
  expect(budgeted.length < history.length);
  expect(budgeted[0].role == "system");
  expect(historyChars(history) > 0);
  expect(estimateTokens("abcdefgh") == 2);
  let text = transcript(history);
  expect(text.includes("system: You are concise."));
  expect(text.includes("user: What is Lumen?"));
});

test("summary memory through the barrel", () => {
  let history: LumenAiMessage[] = [user("Ship the parser"), assistant("Done Tuesday")];
  let prompt = summaryPrompt(history, "");
  expect(prompt.includes("(none)"));
  expect(prompt.includes("user: Ship the parser"));
  let folded = applySummary("The team shipped the parser.", [user("What next?")]);
  expect(folded.length == 2);
  expect(folded[0].role == "system");
  expect(folded[0].content.includes("The team shipped the parser."));
});

test("key value memory through the barrel", () => {
  let store = remember("", "name", "Aymen");
  store = remember(store, "lang", "Lumen");
  store = remember(store, "name", "Ada");
  expect(recall(store, "name") == "Ada");
  expect(recall(store, "lang") == "Lumen");
  expect(recall(store, "missing") == "");
});

test("history serialization through the barrel", () => {
  let history: LumenAiMessage[] = [system("be brief"), user("hi")];
  let raw = serializeHistory(history);
  expect(raw.includes("\"role\":\"system\""));
  let parsed = parseHistory(raw);
  expect(parsed.length == 2);
  expect(parsed[1].content == "hi");
  let path = "/tmp/lumen-ai-barrel-history.json";
  saveHistory(path, history);
  let loaded = loadHistory(path);
  expect(loaded.length == 2);
  expect(loaded[0].content == "be brief");
});

function barrelWeatherBody(input: string): string {
  return "18C in " + input;
}

function barrelClockBody(input: string): string {
  return "12:00 in " + input;
}

function barrelTools(): LumenAiTool[] {
  let tools = registerTool(toolRegistry(), defineTool("weather", "Current weather for a city.", "city name", barrelWeatherBody));
  tools = registerTool(tools, defineTool("clock", "The local time in a zone.", "zone name", barrelClockBody));
  return tools;
}

function barrelAgentHistory(): LumenAiMessage[] {
  let history: LumenAiMessage[] = [
    system(agentSystemPrompt(barrelTools(), "You are a weather assistant.")),
    user("What is the weather in Paris?"),
  ];
  return history;
}

test("tool registry through the barrel", () => {
  let tools = barrelTools();
  expect(tools.length == 2);
  expect(hasTool(tools, "weather"));
  expect(!hasTool(tools, "missing"));
  expect(findTool(tools, "clock") == 1);
  expect(findTool(tools, "missing") == -1);
  let names = toolNames(tools);
  expect(names.length == 2);
  expect(names[0] == "weather");
  let block = toolDescriptions(tools);
  expect(block.includes("- weather(city name): Current weather for a city."));
  expect(toolDescriptions(toolRegistry()) == "");
  let replaced = registerTool(tools, defineTool("weather", "Replaced.", "city", barrelClockBody));
  expect(replaced.length == 2);
  expect(tools[0].description == "Current weather for a city.");
});

test("tool dispatch through the barrel", () => {
  let tools = barrelTools();
  let ok = runTool(tools, "weather", "Paris");
  expect(ok.ok);
  expect(ok.output == "18C in Paris");
  expect(toolMessage(ok).role == "tool");
  expect(toolMessage(ok).content == "[tool weather] 18C in Paris");
  let missing = runTool(tools, "nope", "x");
  expect(!missing.ok);
  expect(missing.error.includes("unknown tool"));
  expect(toolMessage(missing).content.includes("error: unknown tool"));
  let denied = runToolGuarded(tools, [], ["weather"], "weather", "Paris");
  expect(!denied.ok);
  expect(denied.error.includes("denied"));
  let allowed = runToolGuarded(tools, ["weather"], [], "weather", "Paris");
  expect(allowed.ok);
  let outside = runToolGuarded(tools, ["weather"], [], "clock", "CET");
  expect(!outside.ok);
});

test("tool call parsing through the barrel", () => {
  let raw = fakeToolCall("weather", "Paris");
  expect(hasToolCalls(raw));
  expect(finishReason(raw) == "tool_calls");
  let calls = toolCalls(raw);
  expect(calls.length == 1);
  expect(calls[0].name == "weather");
  expect(toolInput(calls[0]) == "Paris");
  expect(toolCallArg(calls[0], "input") == "Paris");
  expect(toolCallArg(calls[0], "missing") == "");
  let mistral = parseMistralToolCalls(raw);
  expect(mistral.length == 1);
  let answer = fakeAnswer("all done");
  expect(!hasToolCalls(answer));
  expect(finishReason(answer) == "stop");
  expect(toolCalls("not json").length == 0);
  let manual = toolCall("call_1", "clock", "{\"input\":\"CET\"}");
  expect(toolInput(manual) == "CET");
});

test("tool definitions through the barrel", () => {
  let body = serializeToolDefs(barrelTools());
  expect(body.includes("\"name\":\"weather\""));
  expect(body.includes("\"type\":\"function\""));
  expect(body.includes("\"required\":[\"input\"]"));
  expect(serializeToolDefsMistral(barrelTools()) == body);
  expect(serializeToolDefs(toolRegistry()) == "[]");
});

test("agent system prompt through the barrel", () => {
  let prompt = agentSystemPrompt(barrelTools(), "You are a weather assistant.");
  expect(prompt.startsWith("You are a weather assistant."));
  expect(prompt.includes("- weather(city name): Current weather for a city."));
  expect(prompt.includes("final answer"));
});

test("agent loop through the barrel", () => {
  let model = fakeModel([
    fakeToolCall("weather", "Paris"),
    fakeAnswer("It is 18C in Paris."),
  ]);
  let result = runAgent(model, barrelTools(), barrelAgentHistory(), 4);
  expect(result.stopReason == "final");
  expect(result.answer == "It is 18C in Paris.");
  expect(result.stepCount == 2);
  expect(result.steps.length == 1);
  expect(result.steps[0].tool == "weather");
  expect(result.steps[0].input == "Paris");
  expect(result.steps[0].output == "18C in Paris");
  expect(result.steps[0].ok);
  let trace = agentTrace(result);
  expect(trace.includes("1. weather(Paris) -> 18C in Paris"));
  expect(trace.includes("stopped: final after 2 model calls, 1 tool call"));
});

test("agent step limit through the barrel", () => {
  let model = fakeModel([
    fakeToolCall("weather", "Paris"),
    fakeToolCall("clock", "CET"),
    fakeToolCall("weather", "Lyon"),
  ]);
  let result = runAgent(model, barrelTools(), barrelAgentHistory(), 2);
  expect(result.stopReason == "max_steps");
  expect(result.stepCount == 2);
  expect(result.steps.length == 2);
  expect(agentTrace(result).includes("stopped: max_steps"));
});

test("agent policy through the barrel", () => {
  let model = fakeModel([
    fakeToolCall("clock", "CET"),
    fakeAnswer("I cannot check the clock."),
  ]);
  let deny: string[] = ["clock"];
  let allow: string[] = [];
  let result = runAgentWithPolicy(model, barrelTools(), allow, deny, barrelAgentHistory(), 4);
  expect(result.stopReason == "final");
  expect(result.steps.length == 1);
  expect(!result.steps[0].ok);
  expect(result.steps[0].output.includes("blocked by policy"));
  expect(result.answer == "I cannot check the clock.");
});

test("agent step record through the barrel", () => {
  let step = agentStep(0, "weather", "Paris", "18C in Paris", true);
  expect(step.index == 0);
  expect(step.tool == "weather");
  expect(step.ok);
});

test("live tool-calling agent surface through the barrel", () => {
  let tools = barrelTools();
  let history: LumenAiMessage[] = [
    system("You are a weather assistant."),
    user("weather in Paris?"),
    assistant("[tool_calls] weather({\"input\":\"Paris\"})"),
    toolMessage(runTool(tools, "weather", "Paris")),
  ];
  // The neutral history rebuilds into native turns with matching ids.
  let turns = agentChatTurns(history);
  expect(turns.length == 4);
  expect(turns[2].role == "assistant");
  expect(turns[2].tool_calls != "");
  expect(turns[3].role == "tool");
  expect(turns[3].tool_call_id == "call_1");
  expect(turns[3].content == "18C in Paris");
  // The tool-enabled body carries both the tools array and the tool_call_id.
  let body = openAIToolBody("gpt-4o-mini", turns, tools, 0.2, 256);
  expect(body.includes("\"tools\":[{\"type\":\"function\""));
  expect(body.includes("\"name\":\"weather\""));
  expect(body.includes("\"tool_call_id\":\"call_1\""));
  expect(mistralToolBody("gpt-4o-mini", turns, tools, 0.2, 256) == body);
  // The rebuilt assistant tool_calls fragment re-parses losslessly.
  let assistantJson = "{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":" + turns[2].tool_calls + "}";
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + assistantJson + "}]}";
  let back = toolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].id == "call_1");
  expect(toolInput(back[0]) == "Paris");
  // The agent model builders yield LumenAiModel closures with no I/O.
  let models: LumenAiModel[] = [
    openAIAgent("sk-test", "gpt-4o-mini", tools),
    mistralAgent("mk-test", "mistral-large-latest", tools),
  ];
  expect(models.length == 2);
});

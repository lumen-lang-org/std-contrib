// ai -- small typed AI helpers for OpenAI-compatible chat APIs.
//
// Public barrel for the package. Implementation is split across focused
// modules so future agents, tools, and retrieval pieces have room to grow.
// Run: lumen test packages/ai/ai.ts

import { systemMessage, userMessage, assistantMessage } from "./core/messages.ts";
import { renderPromptTemplate, missingTemplateVariables as readMissingTemplateVariables, unusedTemplateVariables as readUnusedTemplateVariables, renderChatPrompt as renderFlatChatPrompt, chatPromptRole as readChatPromptRole, chatPromptContent as readChatPromptContent } from "./prompt/prompt.ts";
import { buildChatRequest } from "./core/request.ts";
// providers/chat.ts imports makeModelConfig and modelBaseUrl from core/model.ts
// unaliased, so they are imported unaliased here too. The public wrappers below
// take different names, so nothing collides.
import { makeModelConfig, modelBaseUrl, modelWithTemperature, modelWithMaxTokens, modelWithBaseUrl, modelWithApiKey } from "./core/model.ts";
import { runConfiguredChat } from "./providers/chat.ts";
import { makeAiResult } from "./core/result.ts";
import { makeProviderError } from "./core/error.ts";
import { makeModelOptions, defaultModelOptions as makeDefaultModelOptions } from "./core/options.ts";
import { buildProviderChatBody } from "./core/provider.ts";
// structured.ts imports firstJsonObjectOutput, typedJsonInputOutput and
// retryPromptOutput UNALIASED, so those three are imported unaliased here too;
// their public wrappers already use different names, so nothing collides.
import { firstJsonObjectOutput, typedJsonInputOutput, retryPromptOutput, parseTextOutput as readTextOutput, parseLineOutput as readLineOutput, parseStringListOutput as readStringListOutput, parseChoiceOutput as readChoiceOutput, firstFencedBlockOutput as readFirstFencedBlockOutput } from "./prompt/output.ts";
import { makeAuthHeaders, runOpenAIChat, runOpenAIChatWithBaseUrl, buildOpenAIChatBody, buildOpenAIChatBodyWithStops, readOpenAIContent, readOpenAIResult, readOpenAIError, readOpenAITokenUsage } from "./providers/openai.ts";
import { makeMistralAuthHeaders, runMistralChat, runMistralChatWithBaseUrl, buildMistralChatBody, buildMistralChatBodyWithStops, readMistralContent, readMistralResult, readMistralError, readMistralTokenUsage } from "./providers/mistral.ts";
// Names a sibling module imports (cosineSimilarity, fakeEmbedding,
// makeDocument, withMetadata, documentMetadata, emptyVectorStore,
// addDocuments, searchByText) are imported here WITHOUT an alias: module
// inlining renames the definition itself, so aliasing one of them would break
// the sibling that imports it under its original name.
import { dotProduct as computeDotProduct, vectorNorm as computeVectorNorm, normalizeVector as computeNormalizeVector, cosineSimilarity, euclideanDistance as computeEuclideanDistance, fakeEmbedding } from "./rag/vector.ts";
import { makeDocument, documentMetadata, withMetadata, splitFixed as splitFixedText, splitRecursive as splitRecursiveText, splitParagraphs as splitParagraphText, splitToDocuments as splitTextToDocuments } from "./rag/document.ts";
import { embeddingBody as buildEmbeddingBody, embeddingBodyBatch as buildEmbeddingBodyBatch, parseEmbeddingResponse as readEmbeddingResponse, parseEmbeddingBatch as readEmbeddingBatch, embedOpenAI as runEmbedOpenAI, embedOpenAIWithBaseUrl as runEmbedOpenAIWithBaseUrl, embedMistral as runEmbedMistral, embedBatchWithBaseUrl as runEmbedBatchWithBaseUrl, embedBatchOpenAI as runEmbedBatchOpenAI, embedBatchMistral as runEmbedBatchMistral, embedBatchWithConfig as runEmbedBatchWithConfig } from "./rag/embed.ts";
import { emptyVectorStore, storeSize as readStoreSize, addVector as addStoreVector, addDocuments, deleteById as deleteStoreDocument, filterByMetadata as filterStoreByMetadata, searchByVector as runSearchByVector, searchByText } from "./rag/store.ts";
import { tokenizeQuery as readQueryTerms, keywordScore as computeKeywordScore, keywordRetrieve as runKeywordRetrieve, vectorRetrieve as runVectorRetrieve, hybridRetrieve as runHybridRetrieve, formatContext as buildRagContext, ragPrompt as buildRagPrompt, ragMessages as buildRagMessages } from "./rag/retrieve.ts";
import { needsCompression as historyNeedsCompression, compressHistory as foldHistory, compressIfNeeded as foldHistoryIfNeeded, appendMessage as pushHistoryMessage, windowMemory as applyWindowMemory, charBudgetMemory as applyCharBudgetMemory, estimateTokens as computeEstimateTokens, historyChars as computeHistoryChars, renderTranscript as buildTranscript, summaryPrompt as buildSummaryPrompt, applySummary as buildSummaryHistory, setMemoryValue as writeMemoryValue, getMemoryValue as readMemoryValue, serializeHistory as writeHistoryJson, parseHistory as readHistoryJson, saveHistory as writeHistoryFile, loadHistory as readHistoryFile } from "./memory/memory.ts";
// Same rule for the tool and agent layers: toolcall.ts imports makeTool, and
// agent.ts imports makeTool, describeTools, runToolWithPolicy,
// toolResultMessage, parseToolCalls, toolCallInput, makeToolCall and
// toolCallArgument. Those eight names are imported here WITHOUT an alias, so
// their public wrappers below take a different name rather than renaming the
// definition out from under a sibling.
import { makeTool, describeTools, runToolWithPolicy, toolResultMessage, toolRegistry as emptyToolRegistry, registerTool as addToolEntry, findTool as findToolIndex, hasTool as hasToolNamed, toolNames as readToolNames, runTool as dispatchTool } from "./agent/tools.ts";
import { makeToolCall, toolCallArgument, toolCallInput, parseToolCalls, serializeToolDefs as buildToolDefs, serializeToolDefsMistral as buildToolDefsMistral, parseMistralToolCalls as readMistralToolCalls, hasToolCalls as responseHasToolCalls, finishReason as readFinishReason } from "./agent/toolcall.ts";
import { runAgent as runAgentLoop, runAgentWithPolicy as runAgentLoopWithPolicy, agentSystemPrompt as buildAgentSystemPrompt, agentTrace as renderAgentTrace, makeAgentStep as buildAgentStep, fakeModel as makeFakeModel, agentFakeAnswer as buildFakeAnswer, agentFakeToolCall as buildFakeToolCall, openAIAgentModel as makeOpenAIAgentModel, mistralAgentModel as makeMistralAgentModel, agentHistoryToTurns as buildAgentTurns } from "./agent/agent.ts";
// toolchat.ts is already inlined through agent.ts (which imports several of its
// functions), so its exports are in scope under their ORIGINAL names. Importing
// them here under an alias would not bind — the module was inlined once already.
// So every toolchat name is imported unaliased, exactly like the sibling-shared
// vector/tool names above, and the public wrappers below take a different name.
import { buildOpenAIToolBody, buildMistralToolBody, runOpenAIToolChat, runMistralToolChat } from "./agent/toolchat.ts";
// mcp.ts declares McpTool / McpResult unexported; importing any value
// from it brings those types into scope.
// mcp_stdio.ts and mcp_sse.ts import six of mcp.ts's helpers UNALIASED
// (mcpInitializeRequest, mcpListToolsRequest, mcpCallToolRequest, parseMcpTools,
// parseMcpToolResult, mcpResponseId), so those six must be imported unaliased
// here too — aliasing one would rename the definition and dangle the siblings'
// bare references. The remaining mcp.ts names are barrel-only, so they stay
// aliased. The two public wrappers whose name would then collide with an
// unaliased import are exposed as mcpParseTools / mcpReplyId.
import { mcpInitializeRequest, mcpListToolsRequest, mcpCallToolRequest, parseMcpTools, parseMcpToolResult, mcpResponseId, mcpRequest as buildMcpRequest, mcpIsError as readMcpIsError, mcpErrorMessage as readMcpErrorMessage, mcpResultField as readMcpResultField, mcpInitialize as runMcpInitialize, mcpListTools as runMcpListTools, mcpCallTool as runMcpCallTool, mcpToolToLumen as adaptMcpTool, mcpToolsToRegistry as adaptMcpTools } from "./mcp/client.ts";
// The stdio and SSE MCP transports (mcp_stdio.ts / mcp_sse.ts) are self-contained
// modules; no sibling imports their names, so every one is aliased here.
import { mcpStdioSpawn as runStdioSpawn, mcpStdioListTools as runStdioListTools, mcpStdioCall as runStdioCall, mcpStdioClose as runStdioClose, mcpStdioToolToLumen as adaptStdioTool, mcpStdioToolsToRegistry as adaptStdioTools } from "./mcp/stdio.ts";
import { schemaField as makeSchemaField, objectSchema as buildObjectSchema, requiredFields as readRequiredFields, jsonObjectBody as buildJsonObjectBody, jsonSchemaBody as buildJsonSchemaBody, validateStructured as checkStructured, parseStructuredResponse as readStructuredResponse, structuredRetryPrompt as buildStructuredRetryPrompt, schemaInstruction as buildSchemaInstruction, structuredChat as runStructuredChat, structuredChatWithBaseUrl as runStructuredChatWithBaseUrl, structuredOpenAI as runStructuredOpenAI, structuredOpenAIWithBaseUrl as runStructuredOpenAIWithBaseUrl, structuredMistral as runStructuredMistral, structuredJsonModeWithBaseUrl as runStructuredJsonMode } from "./prompt/structured.ts";
import { makeSubAgent as defineSubAgent, subAgentAsTool as wrapSubAgent, subAgentsAsTools as wrapSubAgents, runSubAgent as dispatchSubAgent, subAgentAnswer as runSubAgentAnswer } from "./agent/subagent.ts";
import { makeBudget as newBudget, unlimitedBudget as newUnlimitedBudget, budgetIsLimited as readBudgetLimited, budgetRemaining as readBudgetRemaining, budgetExhausted as readBudgetExhausted, messagesCost as readMessagesCost, chargeBudget as applyCharge, chargeMessages as applyChargeMessages, chargeCall as applyChargeCall, budgetAllows as readBudgetAllows, budgetAllowsMessages as readBudgetAllowsMessages, budgetRefusal as readBudgetRefusal } from "./agent/budget.ts";
import { splitChunks as splitTextChunks, splitChunksWith as splitTextChunksWith, splitMarkdownChunks as splitMdChunks, splitCodeChunks as splitSrcChunks, splitDocumentChunks as splitDocChunks, splitDocumentProse as splitDocProse, textSeparators as proseSeparators, markdownSeparators as mdSeparators, codeSeparators as srcSeparators } from "./rag/split.ts";
import { loadText as readTextDocument, loadFile as readFileDocument, loadDirectory as readDirectoryDocuments, fileExtension as readFileExtension } from "./rag/loader.ts";
import { streamEventFromLine as readStreamEvent, streamLinePayload as readStreamPayload, streamEventsFromBody as readStreamEvents, streamBodyText as readStreamBodyText, buildStreamChatBody as makeStreamChatBody, streamConfiguredChat as runStreamChat, streamChatToString as runStreamChatToString } from "./providers/stream.ts";
import { sseListTools as runSseListTools, sseCall as runSseCall, sseToolToLumen as adaptSseTool, sseToolsToRegistry as adaptSseTools } from "./mcp/sse.ts";

type JsonName = {
  name: string,
};

export function system(content: string): AiMessage {
  return systemMessage(content);
}

export function user(content: string): AiMessage {
  return userMessage(content);
}

export function assistant(content: string): AiMessage {
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

export function systemTemplate(template: string, keys: string[], values: string[]): AiMessage {
  return system(renderPromptTemplate(template, keys, values));
}

export function userTemplate(template: string, keys: string[], values: string[]): AiMessage {
  return user(renderPromptTemplate(template, keys, values));
}

export function assistantTemplate(template: string, keys: string[], values: string[]): AiMessage {
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

export function chatRequest(provider: string, model: string, messages: AiMessage[], temperature: number, maxTokens: int): AiChatRequest {
  return buildChatRequest(provider, model, messages, temperature, maxTokens);
}

export function aiResult(status: int, ok: bool, content: string, raw: string): AiResult {
  return makeAiResult(status, ok, content, raw);
}

export function providerError(provider: string, status: int, message: string, raw: string): AiProviderError {
  return makeProviderError(provider, status, message, raw);
}

export function modelOptions(temperature: number, maxTokens: int): AiModelOptions {
  return makeModelOptions(temperature, maxTokens);
}

export function defaultModelOptions(): AiModelOptions {
  return makeDefaultModelOptions();
}

export function providerChatBody(provider: string, model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
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
  return firstJsonObjectOutput(raw);
}

export function typedJsonInput(raw: string): string {
  return typedJsonInputOutput(raw);
}

export function retryPrompt(instruction: string, invalidOutput: string, errorMessage: string): string {
  return retryPromptOutput(instruction, invalidOutput, errorMessage);
}

export function openAIChatBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  return buildOpenAIChatBody(model, messages, temperature, maxTokens);
}

export function openAIChatBodyWithStops(model: string, messages: AiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
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

export function parseOpenAIResult(status: int, ok: bool, raw: string): AiResult {
  return readOpenAIResult(status, ok, raw);
}

export function parseOpenAIError(status: int, raw: string): AiProviderError {
  return readOpenAIError(status, raw);
}

export function parseOpenAITokenUsage(raw: string): AiTokenUsage {
  return readOpenAITokenUsage(raw);
}

export function chatOpenAIWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[]): AiResult {
  return runOpenAIChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatOpenAI(apiKey: string, model: string, messages: AiMessage[]): AiResult {
  return runOpenAIChat(apiKey, model, messages);
}

export function mistralChatBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  return buildMistralChatBody(model, messages, temperature, maxTokens);
}

export function mistralChatBodyWithStops(model: string, messages: AiMessage[], temperature: number, maxTokens: int, stop: string[]): string {
  return buildMistralChatBodyWithStops(model, messages, temperature, maxTokens, stop);
}

export function parseMistralContent(raw: string): string {
  return readMistralContent(raw);
}

export function parseMistralResult(status: int, ok: bool, raw: string): AiResult {
  return readMistralResult(status, ok, raw);
}

export function parseMistralError(status: int, raw: string): AiProviderError {
  return readMistralError(status, raw);
}

export function parseMistralTokenUsage(raw: string): AiTokenUsage {
  return readMistralTokenUsage(raw);
}

export function chatMistralWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[]): AiResult {
  return runMistralChatWithBaseUrl(baseUrl, apiKey, model, messages);
}

export function chatMistral(apiKey: string, model: string, messages: AiMessage[]): AiResult {
  return runMistralChat(apiKey, model, messages);
}

export function document(id: string, text: string, source: string, metadata: string): AiDocument {
  return makeDocument(id, text, source, metadata);
}

export function docMetadata(doc: AiDocument, key: string): string {
  return documentMetadata(doc, key);
}

export function withDocMetadata(doc: AiDocument, key: string, value: string): AiDocument {
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

export function splitDocuments(text: string, source: string, size: int, overlap: int): AiDocument[] {
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

export function vectorStore(): AiVectorStore {
  return emptyVectorStore();
}

export function storeSize(store: AiVectorStore): int {
  return readStoreSize(store);
}

export function addVector(store: AiVectorStore, doc: AiDocument, vector: number[]): AiVectorStore {
  return addStoreVector(store, doc, vector);
}

export function addDocs(store: AiVectorStore, docs: AiDocument[], dims: int): AiVectorStore {
  return addDocuments(store, docs, dims);
}

export function deleteDoc(store: AiVectorStore, id: string): AiVectorStore {
  return deleteStoreDocument(store, id);
}

export function filterDocs(store: AiVectorStore, key: string, value: string): AiVectorStore {
  return filterStoreByMetadata(store, key, value);
}

export function searchVector(store: AiVectorStore, query: number[], k: int): AiSearchHit[] {
  return runSearchByVector(store, query, k);
}

export function search(store: AiVectorStore, query: string, dims: int, k: int): AiSearchHit[] {
  return searchByText(store, query, dims, k);
}

export function queryTerms(text: string): string[] {
  return readQueryTerms(text);
}

export function keywordScore(doc: AiDocument, terms: string[]): number {
  return computeKeywordScore(doc, terms);
}

export function keywordRetrieve(docs: AiDocument[], query: string, k: int): AiSearchHit[] {
  return runKeywordRetrieve(docs, query, k);
}

export function vectorRetrieve(store: AiVectorStore, query: string, dims: int, k: int): AiSearchHit[] {
  return runVectorRetrieve(store, query, dims, k);
}

export function retrieve(store: AiVectorStore, docs: AiDocument[], query: string, dims: int, k: int): AiSearchHit[] {
  return runHybridRetrieve(store, docs, query, dims, k);
}

export function formatContext(hits: AiSearchHit[]): string {
  return buildRagContext(hits);
}

export function ragPrompt(question: string, hits: AiSearchHit[]): string {
  return buildRagPrompt(question, hits);
}

export function ragMessages(question: string, hits: AiSearchHit[]): AiMessage[] {
  return buildRagMessages(question, hits);
}

export function appendMessage(history: AiMessage[], msg: AiMessage): AiMessage[] {
  return pushHistoryMessage(history, msg);
}

export function windowMemory(history: AiMessage[], turns: int): AiMessage[] {
  return applyWindowMemory(history, turns);
}

export function budgetMemory(history: AiMessage[], maxChars: int): AiMessage[] {
  return applyCharBudgetMemory(history, maxChars);
}

export function estimateTokens(text: string): int {
  return computeEstimateTokens(text);
}

export function historyChars(history: AiMessage[]): int {
  return computeHistoryChars(history);
}

export function transcript(history: AiMessage[]): string {
  return buildTranscript(history);
}

export function summaryPrompt(history: AiMessage[], priorSummary: string): string {
  return buildSummaryPrompt(history, priorSummary);
}

export function applySummary(summary: string, recent: AiMessage[]): AiMessage[] {
  return buildSummaryHistory(summary, recent);
}

export function remember(store: string, key: string, value: string): string {
  return writeMemoryValue(store, key, value);
}

export function recall(store: string, key: string): string {
  return readMemoryValue(store, key);
}

export function serializeHistory(history: AiMessage[]): string {
  return writeHistoryJson(history);
}

export function parseHistory(raw: string): AiMessage[] {
  return readHistoryJson(raw);
}

export function saveHistory(path: string, history: AiMessage[]): void {
  writeHistoryFile(path, history);
}

export function loadHistory(path: string): AiMessage[] {
  return readHistoryFile(path);
}

// A tool is a name, a description the model reads, a one-line note about the
// input, and a function from one string to one string. V1 tools take and return
// text; a tool body must not throw, so report trouble by returning it.
export function defineTool(name: string, description: string, params: string, run: (input: string) => string): AiTool {
  return makeTool(name, description, params, run);
}

export function toolRegistry(): AiTool[] {
  return emptyToolRegistry();
}

export function registerTool(tools: AiTool[], entry: AiTool): AiTool[] {
  return addToolEntry(tools, entry);
}

export function findTool(tools: AiTool[], name: string): int {
  return findToolIndex(tools, name);
}

export function hasTool(tools: AiTool[], name: string): bool {
  return hasToolNamed(tools, name);
}

export function toolNames(tools: AiTool[]): string[] {
  return readToolNames(tools);
}

export function toolDescriptions(tools: AiTool[]): string {
  return describeTools(tools);
}

export function runTool(tools: AiTool[], name: string, input: string): AiToolResult {
  return dispatchTool(tools, name, input);
}

// Deny wins over allow, and an empty allow list means everything not denied.
export function runToolGuarded(tools: AiTool[], allow: string[], deny: string[], name: string, input: string): AiToolResult {
  return runToolWithPolicy(tools, allow, deny, name, input);
}

export function toolMessage(result: AiToolResult): AiMessage {
  return toolResultMessage(result);
}

export function toolCall(id: string, name: string, args: string): AiToolCall {
  return makeToolCall(id, name, args);
}

export function toolCalls(raw: string): AiToolCall[] {
  return parseToolCalls(raw);
}

export function parseMistralToolCalls(raw: string): AiToolCall[] {
  return readMistralToolCalls(raw);
}

export function toolCallArg(call: AiToolCall, key: string): string {
  return toolCallArgument(call, key);
}

export function toolInput(call: AiToolCall): string {
  return toolCallInput(call);
}

export function hasToolCalls(raw: string): bool {
  return responseHasToolCalls(raw);
}

export function finishReason(raw: string): string {
  return readFinishReason(raw);
}

export function serializeToolDefs(tools: AiTool[]): string {
  return buildToolDefs(tools);
}

export function serializeToolDefsMistral(tools: AiTool[]): string {
  return buildToolDefsMistral(tools);
}

export function agentStep(index: int, name: string, input: string, output: string, ok: bool): AiAgentStep {
  return buildAgentStep(index, name, input, output, ok);
}

export function agentSystemPrompt(tools: AiTool[], instruction: string): string {
  return buildAgentSystemPrompt(tools, instruction);
}

// One step is one model call plus every tool call it asked for, so `maxSteps`
// bounds model calls and the loop terminates even against a model that asks for
// a tool forever.
export function runAgent(model: AiModel, tools: AiTool[], history: AiMessage[], maxSteps: int): AiAgentResult {
  return runAgentLoop(model, tools, history, maxSteps);
}

export function runAgentWithPolicy(model: AiModel, tools: AiTool[], allow: string[], deny: string[], history: AiMessage[], maxSteps: int): AiAgentResult {
  return runAgentLoopWithPolicy(model, tools, allow, deny, history, maxSteps);
}

export function agentTrace(result: AiAgentResult): string {
  return renderAgentTrace(result);
}

// Offline model driver for tests and examples: it replays canned provider
// bodies in order, then answers "done". Start a fake run from a system/user
// history, because the turn is counted off the assistant messages already in
// the conversation.
export function fakeModel(responses: string[]): AiModel {
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
export function openAIAgent(apiKey: string, model: string, tools: AiTool[]): AiModel {
  return makeOpenAIAgentModel(apiKey, model, tools);
}

export function mistralAgent(apiKey: string, model: string, tools: AiTool[]): AiModel {
  return makeMistralAgentModel(apiKey, model, tools);
}

// Rebuild the native turn history (with native tool_calls and tool_call_id) that
// a live tool round trip needs from the loop's provider-neutral message history.
export function agentChatTurns(messages: AiMessage[]): AiChatTurn[] {
  return buildAgentTurns(messages);
}

// Build a tool-enabled chat request body from native turns: the serialized tool
// definitions ride in the `tools` field, dropped entirely when the registry is
// empty.
export function openAIToolBody(model: string, turns: AiChatTurn[], tools: AiTool[], temperature: number, maxTokens: int): string {
  return buildOpenAIToolBody(model, turns, tools, temperature, maxTokens);
}

export function mistralToolBody(model: string, turns: AiChatTurn[], tools: AiTool[], temperature: number, maxTokens: int): string {
  return buildMistralToolBody(model, turns, tools, temperature, maxTokens);
}

// One tool-enabled round trip: POST the native turns plus tool definitions and
// return the raw response body for parseToolCalls / finishReason to read.
export function toolChatOpenAI(apiKey: string, model: string, turns: AiChatTurn[], tools: AiTool[]): string {
  return runOpenAIToolChat(apiKey, model, turns, tools);
}

export function toolChatMistral(apiKey: string, model: string, turns: AiChatTurn[], tools: AiTool[]): string {
  return runMistralToolChat(apiKey, model, turns, tools);
}

// MCP (Model Context Protocol) over HTTP JSON-RPC. Transport is HTTP only: each
// call is one POST and one complete JSON reply. `params` and `argumentsJson` are
// raw JSON strings embedded verbatim; method and tool names are escaped for you.
export function mcpRequestBody(id: int, method: string, params: string): string {
  return buildMcpRequest(id, method, params);
}

// --- Model configuration ----------------------------------------------------
// One value carrying the provider, model name, credential and generation
// options, so a call site names a model instead of threading four arguments.
// Unlike chatOpenAI / chatMistral, `chat` honours temperature and maxTokens.

export function modelConfig(provider: string, model: string, apiKey: string): AiModelConfig {
  return makeModelConfig(provider, model, apiKey);
}

export function withTemperature(cfg: AiModelConfig, temperature: number): AiModelConfig {
  return modelWithTemperature(cfg, temperature);
}

export function withMaxTokens(cfg: AiModelConfig, maxTokens: int): AiModelConfig {
  return modelWithMaxTokens(cfg, maxTokens);
}

export function withBaseUrl(cfg: AiModelConfig, baseUrl: string): AiModelConfig {
  return modelWithBaseUrl(cfg, baseUrl);
}

export function withApiKey(cfg: AiModelConfig, apiKey: string): AiModelConfig {
  return modelWithApiKey(cfg, apiKey);
}

// The endpoint a config resolves to ("" when unroutable).
export function modelEndpoint(cfg: AiModelConfig): string {
  return modelBaseUrl(cfg);
}

// Send messages using a config.
export function chat(cfg: AiModelConfig, messages: AiMessage[]): AiResult {
  return runConfiguredChat(cfg, messages);
}

// --- Subagents ----------------------------------------------------------------
// Delegate a task to a child agent and get one answer back. The child starts
// from a written task description, not the parent's history, and only its
// final message returns — a child that makes twenty tool calls costs the
// parent one message.

export function subAgent(name: string, description: string, provider: string, apiKey: string, model: string, systemPrompt: string, tools: AiTool[], maxSteps: int): AiSubAgent {
  return defineSubAgent(name, description, provider, apiKey, model, systemPrompt, tools, maxSteps);
}

export function subAgentTool(sub: AiSubAgent): AiTool {
  return wrapSubAgent(sub);
}

export function subAgentTools(subs: AiSubAgent[]): AiTool[] {
  return wrapSubAgents(subs);
}

export function delegateToSubAgent(sub: AiSubAgent, task: string): string {
  return dispatchSubAgent(sub, task);
}

// --- Token budget -----------------------------------------------------------
// A ceiling on what a run may spend. Checked before a call and charged after
// one, so an over-budget run stops before spending rather than after noticing.
// Counts are estimates: there is no tokenizer here.

export function budget(limit: int): AiBudget {
  return newBudget(limit);
}

export function unlimitedBudget(): AiBudget {
  return newUnlimitedBudget();
}

export function budgetLimited(b: AiBudget): bool {
  return readBudgetLimited(b);
}

export function budgetLeft(b: AiBudget): int {
  return readBudgetRemaining(b);
}

export function budgetExhausted(b: AiBudget): bool {
  return readBudgetExhausted(b);
}

export function messagesCost(messages: AiMessage[]): int {
  return readMessagesCost(messages);
}

export function chargeTokens(b: AiBudget, tokens: int): AiBudget {
  return applyCharge(b, tokens);
}

export function chargeMessages(b: AiBudget, messages: AiMessage[]): AiBudget {
  return applyChargeMessages(b, messages);
}

export function chargeCall(b: AiBudget, messages: AiMessage[], reply: string): AiBudget {
  return applyChargeCall(b, messages, reply);
}

export function budgetAllows(b: AiBudget, tokens: int): bool {
  return readBudgetAllows(b, tokens);
}

export function budgetAllowsMessages(b: AiBudget, messages: AiMessage[]): bool {
  return readBudgetAllowsMessages(b, messages);
}

export function budgetRefusal(b: AiBudget, tokens: int): string {
  return readBudgetRefusal(b, tokens);
}

// --- Batch embeddings -------------------------------------------------------
// One request for many inputs. A short or failed response yields no vectors
// rather than a partial list, so chunks and vectors cannot drift out of step.

export function embedBatchWithBaseUrl(baseUrl: string, apiKey: string, model: string, inputs: string[]): number[][] {
  return runEmbedBatchWithBaseUrl(baseUrl, apiKey, model, inputs);
}

export function embedBatchOpenAI(apiKey: string, model: string, inputs: string[]): number[][] {
  return runEmbedBatchOpenAI(apiKey, model, inputs);
}

export function embedBatchMistral(apiKey: string, model: string, inputs: string[]): number[][] {
  return runEmbedBatchMistral(apiKey, model, inputs);
}

export function embedBatchWithConfig(cfg: AiModelConfig, inputs: string[]): number[][] {
  return runEmbedBatchWithConfig(cfg, inputs);
}

// --- Documents: splitting and loading ---------------------------------------
// Chunks carry the byte range they came from, so a retrieved chunk can point
// back at its place in the source. Sizes and overlaps are byte counts.

export function chunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitTextChunks(text, size, overlap);
}

export function chunksWith(text: string, separators: string[], size: int, overlap: int): AiChunk[] {
  return splitTextChunksWith(text, separators, size, overlap);
}

export function markdownChunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitMdChunks(text, size, overlap);
}

export function codeChunks(text: string, size: int, overlap: int): AiChunk[] {
  return splitSrcChunks(text, size, overlap);
}

export function splitDocument(doc: AiDocument, size: int, overlap: int): AiDocument[] {
  return splitDocProse(doc, size, overlap);
}

export function splitDocumentWith(doc: AiDocument, separators: string[], size: int, overlap: int): AiDocument[] {
  return splitDocChunks(doc, separators, size, overlap);
}

export function textSeparators(): string[] {
  return proseSeparators();
}

export function markdownSeparators(): string[] {
  return mdSeparators();
}

export function codeSeparators(): string[] {
  return srcSeparators();
}

export function loadText(text: string, source: string): AiDocument {
  return readTextDocument(text, source);
}

export function loadFile(path: string): AiLoadResult {
  return readFileDocument(path);
}

export function loadDirectory(path: string, extensions: string[], recursive: bool): AiLoadResult {
  return readDirectoryDocuments(path, extensions, recursive);
}

export function fileExtension(path: string): string {
  return readFileExtension(path);
}

// --- Streaming --------------------------------------------------------------
// Read a completion as it is generated. `streamChat` calls the handler once per
// event and also returns the assembled reply, so live output and the final text
// come from one call.

export function streamEvent(line: string): AiStreamEvent {
  return readStreamEvent(line);
}

export function streamPayload(line: string): string {
  return readStreamPayload(line);
}

export function streamEvents(body: string): AiStreamEvent[] {
  return readStreamEvents(body);
}

export function streamText(body: string): string {
  return readStreamBodyText(body);
}

export function streamChatBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  return makeStreamChatBody(model, messages, temperature, maxTokens);
}

export function streamChat(cfg: AiModelConfig, messages: AiMessage[], onEvent: AiStreamHandler): AiResult {
  return runStreamChat(cfg, messages, onEvent);
}

export function streamChatCollect(cfg: AiModelConfig, messages: AiMessage[]): AiResult {
  return runStreamChatToString(cfg, messages);
}

// --- Structured output ------------------------------------------------------
// Ask a provider for JSON that conforms to a schema, and get a validated result
// instead of free text. Schema mode constrains the shape; JSON mode only
// guarantees the reply parses, so the shape is prompted and validated locally.

export function schemaField(name: string, fieldType: string, description: string, required: bool): AiSchemaField {
  return makeSchemaField(name, fieldType, description, required);
}

export function objectSchema(fields: AiSchemaField[]): string {
  return buildObjectSchema(fields);
}

export function schemaRequired(fields: AiSchemaField[]): string[] {
  return readRequiredFields(fields);
}

export function jsonObjectBody(model: string, messages: AiMessage[], temperature: number, maxTokens: int): string {
  return buildJsonObjectBody(model, messages, temperature, maxTokens);
}

export function jsonSchemaBody(model: string, messages: AiMessage[], name: string, schemaJson: string, temperature: number, maxTokens: int): string {
  return buildJsonSchemaBody(model, messages, name, schemaJson, temperature, maxTokens);
}

export function validateStructured(json: string, required: string[]): AiStructured {
  return checkStructured(json, required);
}

export function parseStructuredResponse(raw: string, content: string, required: string[]): AiStructured {
  return readStructuredResponse(raw, content, required);
}

export function structuredRetryPrompt(schemaJson: string, invalid: string, reason: string): string {
  return buildStructuredRetryPrompt(schemaJson, invalid, reason);
}

export function schemaInstruction(schemaJson: string): AiMessage {
  return buildSchemaInstruction(schemaJson);
}

// Provider-neutral: "openai" and "mistral" use native schema mode.
export function structuredChat(provider: string, apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return runStructuredChat(provider, apiKey, model, messages, name, schemaJson, required);
}

export function structuredOpenAI(apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return runStructuredOpenAI(apiKey, model, messages, name, schemaJson, required);
}

export function structuredMistral(apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return runStructuredMistral(apiKey, model, messages, name, schemaJson, required);
}

// Schema mode against any other OpenAI-compatible endpoint that supports it.
export function structuredWithBaseUrl(baseUrl: string, apiKey: string, model: string, messages: AiMessage[], name: string, schemaJson: string, required: string[]): AiStructured {
  return runStructuredChatWithBaseUrl(baseUrl, apiKey, model, messages, name, schemaJson, required);
}

// JSON-mode fallback for endpoints without schema mode (Groq, Together,
// OpenRouter, Ollama, ...): the shape is prompted, then validated locally.
export function structuredJsonMode(baseUrl: string, apiKey: string, model: string, messages: AiMessage[], schemaJson: string, required: string[]): AiStructured {
  return runStructuredJsonMode(baseUrl, apiKey, model, messages, schemaJson, required);
}

// --- Context compression ----------------------------------------------------
// Fold a long conversation into a running summary on demand: check the budget,
// compress only when it is exceeded. A failed model call leaves the history
// untouched rather than losing it.

export function needsCompression(history: AiMessage[], maxChars: int): bool {
  return historyNeedsCompression(history, maxChars);
}

export function compressHistory(summarize: AiSummarizer, history: AiMessage[], keepRecent: int): AiMessage[] {
  return foldHistory(summarize, history, keepRecent);
}

export function compressIfNeeded(summarize: AiSummarizer, history: AiMessage[], maxChars: int, keepRecent: int): AiMessage[] {
  return foldHistoryIfNeeded(summarize, history, maxChars, keepRecent);
}

// Summarizers backed by a real provider, ready to hand to the helpers above.
export function openAISummarizer(apiKey: string, model: string): AiSummarizer {
  return (prompt: string) => {
    let msgs: AiMessage[] = [userMessage(prompt)];
    return runOpenAIChat(apiKey, model, msgs).content;
  };
}

export function mistralSummarizer(apiKey: string, model: string): AiSummarizer {
  return (prompt: string) => {
    let msgs: AiMessage[] = [userMessage(prompt)];
    return runMistralChat(apiKey, model, msgs).content;
  };
}

export function mcpConnectBody(): string {
  return mcpInitializeRequest();
}

export function mcpListToolsBody(id: int): string {
  return mcpListToolsRequest(id);
}

export function mcpCallBody(id: int, name: string, argumentsJson: string): string {
  return mcpCallToolRequest(id, name, argumentsJson);
}

// `parseMcpTools` / `mcpResponseId` are imported unaliased from mcp.ts (the
// stdio/SSE transports need them under those names), so the barrel exposes them
// as mcpParseTools / mcpReplyId to avoid a same-name clash with the imports.
export function mcpParseTools(raw: string): McpTool[] {
  return parseMcpTools(raw);
}

export function parseMcpResult(raw: string): McpResult {
  return parseMcpToolResult(raw);
}

export function mcpReplyId(raw: string): int {
  return mcpResponseId(raw);
}

export function mcpIsError(raw: string): bool {
  return readMcpIsError(raw);
}

export function mcpErrorMessage(raw: string): string {
  return readMcpErrorMessage(raw);
}

export function mcpResultField(raw: string): string {
  return readMcpResultField(raw);
}

// Handshake with an MCP server: POST an initialize request and return the raw
// JSON-RPC reply body. Thin HTTP wrapper, so it is untested like the other live
// provider calls.
export function mcpConnect(url: string, headers: Map<string, string>): string {
  return runMcpInitialize(url, headers);
}

export function mcpTools(url: string, headers: Map<string, string>): McpTool[] {
  return runMcpListTools(url, headers);
}

export function mcpCall(url: string, headers: Map<string, string>, name: string, argumentsJson: string): McpResult {
  return runMcpCallTool(url, headers, name, argumentsJson);
}

// Adapt an MCP tool descriptor into a first-class AiTool whose `run` POSTs a
// tools/call request, so an MCP server's tools drop straight into `runAgent`.
export function mcpAsTool(url: string, headers: Map<string, string>, tool: McpTool): AiTool {
  return adaptMcpTool(url, headers, tool);
}

export function mcpAsTools(url: string, headers: Map<string, string>, tools: McpTool[]): AiTool[] {
  return adaptMcpTools(url, headers, tools);
}

// --- MCP over stdio ---------------------------------------------------------
// Spawn a local MCP server as a subprocess and exchange newline-delimited
// JSON-RPC over its stdin/stdout. The session stays live across calls.

export function mcpStdioConnect(command: string, args: string[]): McpStdioSession {
  return runStdioSpawn(command, args);
}

export function mcpStdioTools(session: McpStdioSession): McpTool[] {
  return runStdioListTools(session);
}

export function mcpStdioCall(session: McpStdioSession, name: string, argumentsJson: string): McpResult {
  return runStdioCall(session, name, argumentsJson);
}

export function mcpStdioClose(session: McpStdioSession): void {
  runStdioClose(session);
}

export function mcpStdioAsTools(session: McpStdioSession, tools: McpTool[]): AiTool[] {
  return adaptStdioTools(session, tools);
}

// --- MCP over SSE / streamable HTTP -----------------------------------------
// Talk to an MCP server whose responses stream as chunked Server-Sent Events,
// over a raw TCP socket. Plain http:// only (no TLS).

export function mcpSseTools(url: string, headers: Map<string, string>): McpTool[] {
  return runSseListTools(url, headers);
}

export function mcpSseCall(url: string, headers: Map<string, string>, name: string, argumentsJson: string): McpResult {
  return runSseCall(url, headers, name, argumentsJson);
}

export function mcpSseAsTools(url: string, headers: Map<string, string>, tools: McpTool[]): AiTool[] {
  return adaptSseTools(url, headers, tools);
}

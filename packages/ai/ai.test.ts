// Tests for ai.

import { addDocs, addVector, agentChatTurns, agentStep, agentSystemPrompt, agentTrace, aiResult, appendMessage, applySummary, assistant, assistantTemplate, authHeaders, budgetMemory, chatPromptContent, chatPromptRole, chatRequest, cosine, defaultModelOptions, defineTool, deleteDoc, distance, docMetadata, document, dot, embeddingBody, embeddingBodyBatch, estimateTokens, fakeAnswer, fakeModel, fakeToolCall, filterDocs, findTool, finishReason, firstFencedBlock, firstJsonObject, formatContext, hasTool, hasToolCalls, hashEmbedding, historyChars, keywordRetrieve, keywordScore, loadHistory, mcpAsTool, mcpAsTools, mcpCallBody, mcpConnectBody, mcpErrorMessage, mcpIsError, mcpListToolsBody, mcpParseTools, mcpReplyId, mcpRequestBody, mcpResultField, missingVariables, mistralAgent, mistralAuthHeaders, mistralChatBody, mistralChatBodyWithStops, mistralToolBody, modelOptions, norm, normalize, openAIAgent, openAIChatBody, openAIChatBodyWithStops, openAIToolBody, parseChoice, parseEmbedding, parseEmbeddingBatch, parseHistory, parseLines, parseMcpResult, parseMistralContent, parseMistralError, parseMistralResult, parseMistralTokenUsage, parseMistralToolCalls, parseOpenAIContent, parseOpenAIError, parseOpenAIResult, parseOpenAITokenUsage, parseStringList, parseText, partialTemplate, providerChatBody, providerError, queryTerms, ragMessages, ragPrompt, recall, registerTool, remember, renderChatPrompt, renderTemplate, retrieve, retryPrompt, runAgent, runAgentWithPolicy, runTool, runToolGuarded, saveHistory, search, searchVector, serializeHistory, serializeToolDefs, serializeToolDefsMistral, splitDocuments, splitParagraphs, splitText, splitTextRecursive, storeSize, summaryPrompt, system, systemTemplate, templateVar, promptPart, templateVar, promptPart, toolCall, toolCallArg, toolCalls, toolDescriptions, toolInput, toolMessage, toolNames, toolRegistry, transcript, typedJsonInput, unusedVariables, user, userTemplate, vectorRetrieve, vectorStore, windowMemory, withDocMetadata } from "./ai.ts";

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
  let out = renderTemplate("Write a {{tone}} note to {{name}}. {{tone}} matters.", [
    templateVar("tone", "short"),
    templateVar("name", "Aymen"),
  ]);
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
  let out = partialTemplate("Hello {{name}} from {{place}}", [templateVar("name", "Aymen")]);
  expect(out == "Hello Aymen from {{place}}");
});

test("render chat prompt", () => {
  let entries = renderChatPrompt(
    [promptPart("system", "You are {{tone}}."), promptPart("user", "Explain {{topic}}.")],
    [templateVar("tone", "concise"), templateVar("topic", "Lumen")],
  );
  expect(entries.length == 2);
  expect(chatPromptRole(entries[0]) == "system");
  expect(chatPromptContent(entries[0]) == "You are concise.");
  expect(chatPromptRole(entries[1]) == "user");
  expect(chatPromptContent(entries[1]) == "Explain Lumen.");
});

test("message templates", () => {
  let s = systemTemplate("You are {{tone}}.", [templateVar("tone", "brief")]);
  let u = userTemplate("Explain {{topic}}.", [templateVar("topic", "Lumen")]);
  let a = assistantTemplate("Answer: {{answer}}", [templateVar("answer", "ok")]);
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

function barrelCorpus(): Document[] {
  let out: Document[] = [
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
  let history: Message[] = [system("You are concise.")];
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
  let history: Message[] = [user("Ship the parser"), assistant("Done Tuesday")];
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
  let history: Message[] = [system("be brief"), user("hi")];
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

function barrelTools(): Tool[] {
  let tools = registerTool(toolRegistry(), defineTool("weather", "Current weather for a city.", "city name", barrelWeatherBody));
  tools = registerTool(tools, defineTool("clock", "The local time in a zone.", "zone name", barrelClockBody));
  return tools;
}

function barrelAgentHistory(): Message[] {
  let history: Message[] = [
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
  let history: Message[] = [
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
  // The agent model builders yield Model closures with no I/O.
  let models: Model[] = [
    openAIAgent("sk-test", "gpt-4o-mini", tools),
    mistralAgent("mk-test", "mistral-large-latest", tools),
  ];
  expect(models.length == 2);
});

test("mcp surface through the barrel", () => {
  // Request builders frame JSON-RPC and round-trip their ids.
  let connect = mcpConnectBody();
  expect(mcpReplyId(connect) == 1);
  expect(mcpListToolsBody(2).includes("\"method\":\"tools/list\""));
  let callBody = mcpCallBody(3, "weather", "{\"input\":\"Paris\"}");
  expect(callBody.includes("\"method\":\"tools/call\""));
  expect(mcpReplyId(callBody) == 3);
  expect(mcpRequestBody(5, "ping", "{}").includes("\"method\":\"ping\""));
  // A tools/list reply parses into descriptors and adapts into runnable tools.
  let listReply = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"weather\",\"description\":\"Current weather for a city.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}}}}]}}";
  let descriptors = mcpParseTools(listReply);
  expect(descriptors.length == 1);
  expect(descriptors[0].name == "weather");
  let registry = mcpAsTools("http://127.0.0.1:9/mcp", new Map<string, string>(), descriptors);
  expect(registry.length == 1);
  expect(registry[0].name == "weather");
  expect(registry[0].params == descriptors[0].schema);
  let single = mcpAsTool("http://127.0.0.1:9/mcp", new Map<string, string>(), descriptors[0]);
  expect(single.name == "weather");
  // A tools/call reply parses its text parts; an error reply reports its message.
  let callReply = "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"18C in Paris\"}]}}";
  let res = parseMcpResult(callReply);
  expect(res.ok);
  expect(res.content == "18C in Paris");
  expect(mcpResultField(callReply).startsWith("{\"content\":"));
  let errReply = "{\"jsonrpc\":\"2.0\",\"id\":9,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}";
  expect(mcpIsError(errReply));
  expect(mcpErrorMessage(errReply) == "Method not found");
  let bad = parseMcpResult(errReply);
  expect(!bad.ok);
  expect(bad.error == "Method not found");
});

test("a model config carries provider, model, key and options", () => {
  let m = modelConfig("mistral", "mistral-large-latest", "k");
  expect(m.provider == "mistral");
  expect(m.model == "mistral-large-latest");
  expect(m.apiKey == "k");
  expect(m.temperature == 0.7);
  expect(m.maxTokens == 1024);
  expect(modelEndpoint(m) == "https://api.mistral.ai/v1");
});

test("config helpers return a new value and never mutate", () => {
  let base = modelConfig("openai", "gpt-4o", "k");
  let hot = withTemperature(base, 0.1);
  let big = withMaxTokens(hot, 4096);
  expect(base.temperature == 0.7);
  expect(hot.temperature == 0.1);
  expect(big.temperature == 0.1);
  expect(big.maxTokens == 4096);
  expect(base.maxTokens == 1024);
});

test("baseUrl overrides the provider default and survives other edits", () => {
  let m = withBaseUrl(modelConfig("openai", "llama3", "k"), "http://127.0.0.1:11434/v1");
  expect(modelEndpoint(m) == "http://127.0.0.1:11434/v1");
  expect(modelEndpoint(withTemperature(m, 0.3)) == "http://127.0.0.1:11434/v1");
  expect(withApiKey(m, "other").apiKey == "other");
});

test("an unknown provider without a baseUrl is unroutable, not guessed", () => {
  let m = modelConfig("acme", "x", "k");
  expect(modelEndpoint(m) == "");
  let r = chat(m, [user("hi")]);
  expect(!r.ok);
  expect(r.raw.includes("unroutable"));
});

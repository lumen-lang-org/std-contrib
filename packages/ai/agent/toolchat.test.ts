// Tests for toolchat.

import { assistantToolCallsTurn, buildMistralToolBody, buildOpenAIToolBody, emitChatMessages, emitChatTurn, toChatTurns, toolResultTurn } from "./toolchat.ts";

// structural check only: braces balanced, strings closed. it steps over a quoted
// run as a unit so a brace inside a string cannot unbalance the count. not a
// full JSON validator — the exact-shape JSON.parse checks below cover that.
function chatBalanced(src: string): bool {
  let depth: int = 0;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (c == "\"") {
      i = i + 1;
      let closed: bool = false;
      while (i < src.length) {
        let d = src.charAt(i);
        if (d == "\\") { i = i + 2; continue; }
        if (d == "\"") { closed = true; i = i + 1; break; }
        i = i + 1;
      }
      if (!closed) { return false; }
      continue;
    }
    if (c == "{" || c == "[") { depth = depth + 1; }
    else if (c == "}" || c == "]") {
      depth = depth - 1;
      if (depth < 0) { return false; }
    }
    i = i + 1;
  }
  return depth == 0;
}

function ctSampleTools(): Tool[] {
  let weather = makeTool("weather", "Look up the weather.", "A city name.", (input: string) => "sunny in " + input);
  let clock = makeTool("clock", "Read the clock.", "A time zone.", (input: string) => "12:00 " + input);
  let tools: Tool[] = [weather, clock];
  return tools;
}

test("a plain-history body omits the tools array and round-trips as JSON", () => {
  let turns = toChatTurns([systemMessage("You are helpful."), userMessage("Hello")]);
  let none: Tool[] = [];
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, none, 0.7, 1024);
  expect(body.indexOf("\"tools\":") < 0);
  expect(body.indexOf("\"messages\":[") > 0);
  expect(body.indexOf("\"model\":\"gpt-4o-mini\"") >= 0);
  expect(chatBalanced(body));
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>(body);
  expect(parsed.model == "gpt-4o-mini");
  expect(parsed.max_tokens == 1024);
  expect(parsed.messages.length == 2);
  expect(parsed.messages[0].role == "system");
  expect(parsed.messages[0].content == "You are helpful.");
  expect(parsed.messages[1].role == "user");
  expect(parsed.messages[1].content == "Hello");
});

test("a non-empty registry embeds a valid tools array", () => {
  let turns = toChatTurns([userMessage("weather in Paris?")]);
  let tools = ctSampleTools();
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, tools, 0.2, 256);
  expect(body.indexOf("\"tools\":[{\"type\":\"function\"") > 0);
  expect(body.indexOf("\"name\":\"weather\"") > 0);
  expect(body.indexOf("\"name\":\"clock\"") > 0);
  expect(body.indexOf("\"description\":\"A city name.\"") > 0);
  expect(chatBalanced(body));
  // mistral takes the identical OpenAI-compatible body today.
  expect(buildMistralToolBody("gpt-4o-mini", turns, tools, 0.2, 256) == body);
});

test("an assistant tool-calls turn and two tool-result turns serialize with matching ids", () => {
  let calls: ToolCall[] = [
    makeToolCall("call_a", "weather", "{\"input\":\"Paris\"}"),
    makeToolCall("call_b", "clock", "{\"input\":\"UTC\"}"),
  ];
  let reg = ctSampleTools();
  let r1 = runTool(reg, "weather", "Paris");
  let r2 = runTool(reg, "clock", "UTC");
  let convo: ChatTurn[] = [
    assistantToolCallsTurn("", calls),
    toolResultTurn("call_a", r1),
    toolResultTurn("call_b", r2),
  ];
  let msgs = emitChatMessages(convo);
  expect(chatBalanced(msgs));

  let assistantJson = emitChatTurn(convo[0]);
  let parsedA: ChatAssistantMsgT = JSON.parse<ChatAssistantMsgT>(assistantJson);
  expect(parsedA.role == "assistant");
  expect(parsedA.tool_calls.length == 2);
  expect(parsedA.tool_calls[0].id == "call_a");
  expect(parsedA.tool_calls[0].function.name == "weather");
  expect(parsedA.tool_calls[1].id == "call_b");

  let toolJson = emitChatTurn(convo[1]);
  let parsedT: ChatToolMsgT = JSON.parse<ChatToolMsgT>(toolJson);
  expect(parsedT.role == "tool");
  expect(parsedT.tool_call_id == "call_a");
  expect(parsedT.content == "18C in Paris" || parsedT.content == "sunny in Paris");
  let parsedT2: ChatToolMsgT = JSON.parse<ChatToolMsgT>(emitChatTurn(convo[2]));
  expect(parsedT2.tool_call_id == "call_b");
  expect(parsedT2.content == "12:00 UTC");

  // the rebuilt fragment is lossless: wrapped back into a response body,
  // parseToolCalls recovers every id, name, and decoded input.
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + assistantJson + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 2);
  expect(back[0].id == "call_a");
  expect(back[0].name == "weather");
  expect(toolCallInput(back[0]) == "Paris");
  expect(back[1].id == "call_b");
  expect(toolCallInput(back[1]) == "UTC");
});

test("content escaping holds for quotes, newlines, and unicode", () => {
  let turns = toChatTurns([userMessage("she said \"go\"\nfrom São Paulo")]);
  let none: Tool[] = [];
  let body = buildOpenAIToolBody("m", turns, none, 0.7, 1024);
  expect(body.indexOf("\n") < 0);
  expect(body.indexOf("\\n") > 0);
  expect(body.indexOf("\\\"go\\\"") > 0);
  expect(chatBalanced(body));
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>(body);
  expect(parsed.messages[0].content == "she said \"go\"\nfrom São Paulo");
});

test("a tool call argument with quotes and newlines survives the round trip", () => {
  let odd: ToolCall[] = [
    makeToolCall("call_x", "say", "{\"input\":\"she said \\\"hi\\\"\\nbye\"}"),
  ];
  let turn = assistantToolCallsTurn("thinking", odd);
  let json = emitChatTurn(turn);
  expect(json.indexOf("\n") < 0);
  expect(chatBalanced(json));
  let parsedA: ChatAssistantMsgT = JSON.parse<ChatAssistantMsgT>(json);
  expect(parsedA.content == "thinking");
  expect(parsedA.tool_calls[0].id == "call_x");
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + json + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].name == "say");
  expect(toolCallInput(back[0]) == "she said \"hi\"\nbye");
});

test("a failed tool result serializes as a tool message the model can read", () => {
  let reg = ctSampleTools();
  let miss = runTool(reg, "wether", "Paris");
  let turn = toolResultTurn("call_z", miss);
  let json = emitChatTurn(turn);
  expect(chatBalanced(json));
  let parsed: ChatToolMsgT = JSON.parse<ChatToolMsgT>(json);
  expect(parsed.role == "tool");
  expect(parsed.tool_call_id == "call_z");
  expect(parsed.content.startsWith("error: unknown tool \"wether\""));
});

test("a malformed response is handled by the parse helpers the caller relies on", () => {
  expect(parseToolCalls("<html>502 Bad Gateway</html>").length == 0);
  expect(parseToolCalls("").length == 0);
  expect(parseToolCalls("{not json").length == 0);
  expect(parseToolCalls("{\"choices\":[]}").length == 0);
});

test("lifting history and re-emitting keeps every role and content intact", () => {
  let history: Message[] = [
    systemMessage("You are a weather assistant."),
    userMessage("What is the weather in Paris?"),
  ];
  let turns = toChatTurns(history);
  expect(turns.length == 2);
  expect(turns[0].role == "system");
  expect(turns[1].role == "user");
  expect(turns[0].tool_calls == "");
  expect(turns[0].tool_call_id == "");
  let body = buildOpenAIToolBody("gpt-4o-mini", turns, ctSampleTools(), 0.7, 1024);
  let parsed: ChatPlainBodyT = JSON.parse<ChatPlainBodyT>("{\"model\":\"m\",\"temperature\":0.0,\"max_tokens\":0,\"messages\":" + emitChatMessages(turns) + "}");
  expect(parsed.messages.length == 2);
  expect(parsed.messages[1].content == "What is the weather in Paris?");
  expect(body.indexOf("\"tools\":") > 0);
});

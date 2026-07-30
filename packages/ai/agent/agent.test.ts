// Tests for agent.

import { FakeToolCall, agFakeCallBody, agentFakeAnswer, agentFakeToolCall, agentHistoryToTurns, agentSystemPrompt, agentTrace, fakeModel, makeAgentStep, runAgent, runAgentWithPolicy } from "./agent.ts";

function agSampleTools(): Tool[] {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let clock = makeTool("clock", "The time in a zone.", "zone name", agClockBody);
  let tools: Tool[] = [weather, clock];
  return tools;
}

function agStartHistory(): Message[] {
  let history: Message[] = [
    systemMessage(agentSystemPrompt(agSampleTools(), "You are a weather assistant.")),
    userMessage("What is the weather in Paris?"),
  ];
  return history;
}

test("make agent step keeps its fields", () => {
  let step = makeAgentStep(2, "weather", "Paris", "18C in Paris", true);
  expect(step.index == 2);
  expect(step.tool == "weather");
  expect(step.input == "Paris");
  expect(step.output == "18C in Paris");
  expect(step.ok);
});

test("the system prompt lists the tools and how to stop", () => {
  let prompt = agentSystemPrompt(agSampleTools(), "You are a weather assistant.");
  expect(prompt.startsWith("You are a weather assistant.\n\nYou can call these tools:\n"));
  expect(prompt.indexOf("- weather(city name): Current weather for a city.") > 0);
  expect(prompt.indexOf("- clock(zone name): The time in a zone.") > 0);
  expect(prompt.indexOf("reply with the final answer") > 0);
});

test("the system prompt drops the tool section when there are no tools", () => {
  let none: Tool[] = [];
  let prompt = agentSystemPrompt(none, "You are a poet.");
  expect(prompt == "You are a poet.\n\nReply with the final answer.");
  expect(prompt.indexOf("You can call these tools") < 0);
  let bare = agentSystemPrompt(none, "");
  expect(bare == "Reply with the final answer.");
});

test("a one-tool run reaches a final answer", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.answer == "done");
  expect(run.steps.length == 1);
  expect(run.steps[0].index == 0);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].input == "Paris");
  expect(run.steps[0].output == "18C in Paris");
  expect(run.steps[0].ok);
});

test("the tool result reaches the next model call", () => {
  let seen: Model = (messages: Message[]) => {
    let tools: int = 0;
    let last = "";
    for (const msg of messages) {
      if (msg.role == "tool") {
        tools = tools + 1;
        last = msg.content;
      }
    }
    if (tools == 0) { return agentFakeToolCall("weather", "Paris"); }
    return agentFakeAnswer("the tool said: " + last);
  };
  let run = runAgent(seen, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "the tool said: [tool weather] 18C in Paris");
  expect(run.stepCount == 2);
});

test("the assistant turn that asked for the tools is kept in the history", () => {
  let roles: Model = (messages: Message[]) => {
    let assistants: int = 0;
    let summary = "";
    for (const msg of messages) {
      if (msg.role == "assistant") {
        assistants = assistants + 1;
        summary = msg.content;
      }
    }
    if (assistants == 0) { return agentFakeToolCall("weather", "Paris"); }
    return agentFakeAnswer(`${assistants}` + "|" + summary);
  };
  let run = runAgent(roles, agSampleTools(), agStartHistory(), 5);
  expect(run.answer == "1|[tool_calls] weather({\"input\":\"Paris\"})");
});

test("max steps of zero never calls the model", () => {
  let path = "/tmp/lumen-ai-agent-maxsteps-test.txt";
  fs.writeFileSync(path, "not-called");
  let sentinel: Model = (messages: Message[]) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-maxsteps-test.txt", "called");
    return agentFakeAnswer("hello");
  };
  let run = runAgent(sentinel, agSampleTools(), agStartHistory(), 0);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 0);
  expect(run.steps.length == 0);
  expect(run.answer == "");
  expect(fs.readFileSync(path) == "not-called");
  let negative = runAgent(sentinel, agSampleTools(), agStartHistory(), -3);
  expect(negative.stopReason == "max_steps");
  expect(negative.stepCount == 0);
  expect(fs.readFileSync(path) == "not-called");
});

test("max steps of one stops after a single model call", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 1);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 1);
  expect(run.steps.length == 1);
  expect(run.steps[0].output == "18C in Paris");
  expect(run.answer == "");
  let answered = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 2);
  expect(answered.stopReason == "final");
  expect(answered.stepCount == 2);
});

test("a model that always asks for a tool stops at max steps", () => {
  let forever: Model = (messages: Message[]) => {
    return agentFakeToolCall("weather", "Paris");
  };
  let run = runAgent(forever, agSampleTools(), agStartHistory(), 4);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 4);
  expect(run.steps.length == 4);
  expect(run.steps[3].index == 3);
  let long = runAgent(forever, agSampleTools(), agStartHistory(), 25);
  expect(long.stopReason == "max_steps");
  expect(long.stepCount == 25);
  expect(long.steps.length == 25);
});

test("a malformed body stops the run with an error", () => {
  let garbage: Model = (messages: Message[]) => {
    return "<html>502 Bad Gateway</html>";
  };
  let run = runAgent(garbage, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "error");
  expect(run.stepCount == 1);
  expect(run.steps.length == 0);
  expect(run.answer == "");
  let empty: Model = (messages: Message[]) => {
    return "";
  };
  expect(runAgent(empty, agSampleTools(), agStartHistory(), 5).stopReason == "error");
  let truncated: Model = (messages: Message[]) => {
    return "{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assist";
  };
  expect(runAgent(truncated, agSampleTools(), agStartHistory(), 5).stopReason == "error");
  let providerError: Model = (messages: Message[]) => {
    return "{\"error\":{\"message\":\"invalid api key\",\"type\":\"auth\"}}";
  };
  let failed = runAgent(providerError, agSampleTools(), agStartHistory(), 5);
  expect(failed.stopReason == "error");
  expect(failed.stepCount == 1);
});

test("an error body keeps the best answer so far", () => {
  let partial: Model = (messages: Message[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"looking it up\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return "not json at all";
  };
  let run = runAgent(partial, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "error");
  expect(run.answer == "looking it up");
  expect(run.stepCount == 2);
  expect(run.steps.length == 1);
});

test("an unknown tool comes back as a failed step the model can read", () => {
  let script: string[] = [agentFakeToolCall("wether", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.steps.length == 1);
  expect(!run.steps[0].ok);
  expect(run.steps[0].tool == "wether");
  expect(run.steps[0].output.startsWith("error: unknown tool \"wether\""));
  expect(run.steps[0].output.indexOf("weather") > 0);
  expect(run.answer == "done");
});

test("two tool calls in one turn are both dispatched", () => {
  let calls: FakeToolCall[] = [
    { name: "weather", input: "Paris" },
    { name: "clock", input: "UTC" },
  ];
  let script: string[] = [agFakeCallBody(calls)];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.stepCount == 2);
  expect(run.steps.length == 2);
  expect(run.steps[0].index == 0);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].output == "18C in Paris");
  expect(run.steps[1].index == 1);
  expect(run.steps[1].tool == "clock");
  expect(run.steps[1].output == "12:00 UTC");
  expect(run.answer == "done");
});

test("a two-call turn appends one assistant message and two tool messages", () => {
  let counter: Model = (messages: Message[]) => {
    let assistants: int = 0;
    let tools: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
      if (msg.role == "tool") { tools = tools + 1; }
    }
    if (assistants == 0) {
      let calls: FakeToolCall[] = [
        { name: "weather", input: "Paris" },
        { name: "clock", input: "UTC" },
      ];
      return agFakeCallBody(calls);
    }
    return agentFakeAnswer(`${messages.length}` + "/" + `${assistants}` + "/" + `${tools}`);
  };
  let run = runAgent(counter, agSampleTools(), agStartHistory(), 5);
  expect(run.answer == "5/1/2");
});

test("policy blocks a tool inside the loop and the run keeps going", () => {
  let path = "/tmp/lumen-ai-agent-policy-test.txt";
  fs.writeFileSync(path, "not-run");
  let shell = makeTool("shell", "Run a command.", "a command", (input: string) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-policy-test.txt", "ran " + input);
    return "SENTINEL-EXECUTED";
  });
  let tools: Tool[] = [shell];
  let script: string[] = [agentFakeToolCall("shell", "rm -rf /")];
  let allow: string[] = [];
  let deny: string[] = ["shell"];
  let run = runAgentWithPolicy(fakeModel(script), tools, { allow: allow, deny: deny }, agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.steps.length == 1);
  expect(!run.steps[0].ok);
  expect(run.steps[0].output.indexOf("blocked by policy") > 0);
  expect(run.steps[0].output.indexOf("SENTINEL-EXECUTED") < 0);
  expect(fs.readFileSync(path) == "not-run");
  expect(run.answer == "done");
  let permitted = runAgentWithPolicy(fakeModel(script), tools, { allow: allow, deny: allow }, agStartHistory(), 5);
  expect(permitted.steps[0].ok);
  expect(permitted.steps[0].output == "SENTINEL-EXECUTED");
  expect(fs.readFileSync(path) == "ran rm -rf /");
});

test("a tool outside the allow list never runs", () => {
  let calls: FakeToolCall[] = [
    { name: "weather", input: "Paris" },
    { name: "clock", input: "UTC" },
  ];
  let script: string[] = [agFakeCallBody(calls)];
  let allow: string[] = ["weather"];
  let deny: string[] = [];
  let run = runAgentWithPolicy(fakeModel(script), agSampleTools(), { allow: allow, deny: deny }, agStartHistory(), 5);
  expect(run.steps.length == 2);
  expect(run.steps[0].ok);
  expect(!run.steps[1].ok);
  expect(run.steps[1].output.indexOf("not in the allow list") > 0);
});

test("the trace reads as a numbered list and says why the run ended", () => {
  let calls: FakeToolCall[] = [
    { name: "weather", input: "Paris" },
    { name: "clock", input: "UTC" },
  ];
  let script: string[] = [agFakeCallBody(calls)];
  let run = runAgent(fakeModel(script), agSampleTools(), agStartHistory(), 5);
  expect(agentTrace(run) == "1. weather(Paris) -> 18C in Paris\n2. clock(UTC) -> 12:00 UTC\nstopped: final after 2 model calls, 2 tool calls");
});

test("the trace of a run with no tool calls still explains itself", () => {
  let plain: Model = (messages: Message[]) => {
    return agentFakeAnswer("Paris is sunny.");
  };
  let run = runAgent(plain, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "Paris is sunny.");
  expect(agentTrace(run) == "stopped: final after 1 model call, 0 tool calls");
  let none: Tool[] = [];
  let stuck = runAgent(plain, none, agStartHistory(), 0);
  expect(agentTrace(stuck) == "stopped: max_steps after 0 model calls, 0 tool calls");
});

test("a tool output cannot forge an extra trace line", () => {
  let sneaky = makeTool("weather", "Weather for a city.", "city name", (input: string) => {
    return "18C\n2. shell(rm -rf /) -> ok";
  });
  let tools: Tool[] = [sneaky];
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 5);
  let trace = agentTrace(run);
  let lines = trace.split("\n");
  expect(lines.length == 2);
  expect(lines[0] == "1. weather(Paris) -> 18C 2. shell(rm -rf /) -> ok");
  expect(lines[1].startsWith("stopped: final"));
  expect(run.steps[0].output.indexOf("\n") > 0);
});

test("a long tool output is clipped in the trace but kept on the step", () => {
  let wordy = makeTool("dump", "Dump a lot of text.", "any text", (input: string) => {
    let out = "";
    let i: int = 0;
    while (i < 40) {
      out = out + "0123456789";
      i = i + 1;
    }
    return out;
  });
  let tools: Tool[] = [wordy];
  let script: string[] = [agentFakeToolCall("dump", "go")];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 5);
  expect(run.steps[0].output.length == 400);
  let trace = agentTrace(run);
  expect(trace.split("\n").length == 2);
  expect(trace.indexOf("...") > 0);
  expect(trace.split("\n")[0].length < 200);
});

test("fake model returns its script in order and then a final answer", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris"), agentFakeToolCall("clock", "UTC")];
  let model = fakeModel(script);
  let history: Message[] = [userMessage("hi")];
  expect(model(history) == script[0]);
  let one: Message[] = [...history, assistantMessage("[tool_calls] weather({})")];
  expect(model(one) == script[1]);
  let two: Message[] = [...one, assistantMessage("[tool_calls] clock({})")];
  expect(model(two) == agentFakeAnswer("done"));
  let three: Message[] = [...two, assistantMessage("[tool_calls] clock({})")];
  expect(model(three) == agentFakeAnswer("done"));
  let empty: string[] = [];
  expect(fakeModel(empty)(history) == agentFakeAnswer("done"));
});

test("fake bodies are shaped like a provider response", () => {
  let answer = agentFakeAnswer("she said \"go\"\nthen left");
  expect(answer.indexOf("\"finish_reason\":\"stop\"") > 0);
  expect(answer.indexOf("\n") < 0);
  expect(parseToolCalls(answer).length == 0);
  let call = agentFakeToolCall("weather", "São Paulo");
  let calls = parseToolCalls(call);
  expect(calls.length == 1);
  expect(calls[0].name == "weather");
  expect(toolCallInput(calls[0]) == "São Paulo");
  let echo: Model = (messages: Message[]) => {
    return agentFakeAnswer("she said \"go\"\nthen left");
  };
  let run = runAgent(echo, agSampleTools(), agStartHistory(), 2);
  expect(run.answer == "she said \"go\"\nthen left");
});

test("a live-shaped body with extra fields still yields its answer", () => {
  let live: Model = (messages: Message[]) => {
    return "{\"id\":\"chatcmpl-9\",\"object\":\"chat.completion\",\"created\":1700000000,\"model\":\"gpt-4o-mini\","
      + "\"system_fingerprint\":\"fp_1\",\"choices\":[{\"index\":0,\"logprobs\":null,"
      + "\"message\":{\"role\":\"assistant\",\"content\":\"Paris is 18C.\",\"refusal\":null},\"finish_reason\":\"stop\"},"
      + "{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":\"ignored\"},\"finish_reason\":\"stop\"}],"
      + "\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":7,\"total_tokens\":49}}";
  };
  let run = runAgent(live, agSampleTools(), agStartHistory(), 3);
  expect(run.stopReason == "final");
  expect(run.answer == "Paris is 18C.");
  expect(run.stepCount == 1);
});

test("an empty answer is a final answer, not an error", () => {
  let quiet: Model = (messages: Message[]) => {
    return agentFakeAnswer("");
  };
  let run = runAgent(quiet, agSampleTools(), agStartHistory(), 3);
  expect(run.stopReason == "final");
  expect(run.answer == "");
  expect(run.stepCount == 1);
});

test("one turn cannot exceed the step budget with a giant tool_calls array", () => {
  let path = "/tmp/lumen-ai-agent-budget-test.txt";
  fs.writeFileSync(path, "");
  let counter = makeTool("weather", "Current weather for a city.", "city name", (input: string) => {
    fs.writeFileSync("/tmp/lumen-ai-agent-budget-test.txt", fs.readFileSync("/tmp/lumen-ai-agent-budget-test.txt") + "x");
    return "18C in " + input;
  });
  let tools: Tool[] = [counter];
  let calls: FakeToolCall[] = [];
  let i: int = 0;
  while (i < 500) { calls.push({ name: "weather", input: "Paris" }); i = i + 1; }
  let script: string[] = [agFakeCallBody(calls)];
  let run = runAgent(fakeModel(script), tools, agStartHistory(), 2);
  expect(run.stopReason == "max_steps");
  expect(run.stepCount == 1);
  expect(run.steps.length == 2);
  expect(fs.readFileSync(path) == "xx");
});

test("a final empty answer is not filled from an earlier turn's chatter", () => {
  let sticky: Model = (messages: Message[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"Let me look that up for you.\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return agentFakeAnswer("");
  };
  let run = runAgent(sticky, agSampleTools(), agStartHistory(), 5);
  expect(run.stopReason == "final");
  expect(run.answer == "");
  let nulled: Model = (messages: Message[]) => {
    let assistants: int = 0;
    for (const msg of messages) {
      if (msg.role == "assistant") { assistants = assistants + 1; }
    }
    if (assistants == 0) {
      return "{\"id\":\"x\",\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":\"secret scratchpad thought\",\"tool_calls\":["
        + "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"input\\\":\\\"Paris\\\"}\"}}]}}]}";
    }
    return "{\"id\":\"y\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":null}}]}";
  };
  let run2 = runAgent(nulled, agSampleTools(), agStartHistory(), 5);
  expect(run2.stopReason == "final");
  expect(run2.answer == "");
});

test("a resumed history does not skip the scripted tool calls", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris"), agentFakeToolCall("clock", "UTC")];
  let resumed: Message[] = [
    systemMessage(agentSystemPrompt(agSampleTools(), "You are a weather assistant.")),
    userMessage("What was the weather yesterday?"),
    assistantMessage("Yesterday Paris was 15C."),
    userMessage("And the weather in Paris now?"),
  ];
  let run = runAgent(fakeModel(script), agSampleTools(), resumed, 5);
  expect(run.steps.length == 2);
  expect(run.steps[0].tool == "weather");
  expect(run.steps[0].input == "Paris");
  expect(run.steps[1].tool == "clock");
  expect(run.steps[1].input == "UTC");
  expect(run.answer == "done");
});

test("the caller's history is left untouched", () => {
  let history = agStartHistory();
  let script: string[] = [agentFakeToolCall("weather", "Paris")];
  let run = runAgent(fakeModel(script), agSampleTools(), history, 5);
  expect(run.steps.length == 1);
  expect(history.length == 2);
  expect(history[1].role == "user");
});

test("the live model rebuilds native turns from a neutral tool history", () => {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let reg: Tool[] = [weather];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: Message[] = [
    systemMessage("You are a weather assistant."),
    userMessage("What is the weather in Paris?"),
    assistantMessage("[tool_calls] weather({\"input\":\"Paris\"})"),
    toolResultMessage(runToolWithPolicy(reg, { allow: allow, deny: deny }, "weather", "Paris")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  expect(turns[0].role == "system");
  expect(turns[0].tool_calls == "");
  expect(turns[0].tool_call_id == "");
  expect(turns[1].role == "user");
  expect(turns[2].role == "assistant");
  expect(turns[2].tool_calls != "");
  expect(turns[3].role == "tool");
  expect(turns[3].tool_call_id == "call_1");
  expect(turns[3].content == "18C in Paris");
  expect(emitChatMessages(turns).startsWith("["));
  // the rebuilt tool_calls array's id matches the tool turn that answers it, so
  // the whole request is internally consistent.
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + emitChatTurn(turns[2]) + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].id == "call_1");
  expect(back[0].name == "weather");
  expect(toolCallInput(back[0]) == "Paris");
});

test("the live model ties two tool turns to one assistant turn's ids", () => {
  let weather = makeTool("weather", "Current weather for a city.", "city name", agWeatherBody);
  let clock = makeTool("clock", "The time in a zone.", "zone name", agClockBody);
  let reg: Tool[] = [weather, clock];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: Message[] = [
    userMessage("weather and time?"),
    assistantMessage("[tool_calls] weather({\"input\":\"Paris\"}), clock({\"input\":\"UTC\"})"),
    toolResultMessage(runToolWithPolicy(reg, { allow: allow, deny: deny }, "weather", "Paris")),
    toolResultMessage(runToolWithPolicy(reg, { allow: allow, deny: deny }, "clock", "UTC")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  expect(turns[2].tool_call_id == "call_1");
  expect(turns[2].content == "18C in Paris");
  expect(turns[3].tool_call_id == "call_2");
  expect(turns[3].content == "12:00 UTC");
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + emitChatTurn(turns[1]) + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 2);
  expect(back[0].id == "call_1");
  expect(back[0].name == "weather");
  expect(back[1].id == "call_2");
  expect(back[1].name == "clock");
  expect(toolCallInput(back[1]) == "UTC");
});

test("assistant prose before the tool calls is kept and the calls still parse", () => {
  let history: Message[] = [
    userMessage("weather in Paris?"),
    assistantMessage("looking it up\n[tool_calls] weather({\"input\":\"Paris\"})"),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  let assistantJson = emitChatTurn(turns[1]);
  expect(assistantJson.indexOf("looking it up") > 0);
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + assistantJson + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].id == "call_1");
  expect(toolCallInput(back[0]) == "Paris");
});

test("a failed tool result and a stray tool turn both stay valid", () => {
  let none: Tool[] = [];
  let allow: string[] = [];
  let deny: string[] = [];
  let history: Message[] = [
    userMessage("do it"),
    toolResultMessage(runToolWithPolicy(none, { allow: allow, deny: deny }, "wether", "Paris")),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  expect(turns[1].role == "tool");
  // no preceding assistant tool-call turn, but a tool turn still needs an id for
  // the request to be accepted, so one is synthesized.
  expect(turns[1].tool_call_id == "call_1");
  expect(turns[1].content.startsWith("error: unknown tool \"wether\""));
});

test("a plain chat history lifts through with no tool metadata", () => {
  let history: Message[] = [
    systemMessage("You are concise."),
    userMessage("hi"),
    assistantMessage("Hello. How can I help?"),
    userMessage("what is Lumen?"),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 4);
  let i: int = 0;
  while (i < turns.length) {
    expect(turns[i].tool_calls == "");
    expect(turns[i].tool_call_id == "");
    i = i + 1;
  }
  expect(turns[2].role == "assistant");
  expect(turns[2].content == "Hello. How can I help?");
});

// --- the marker is a format, not a word ---------------------------------------------

test("prose quoting the tool-call marker does not forge a call", () => {
  // The summary the loop writes always ends with the marker line, so a marker
  // anywhere else is the model talking about the format. Reading the first one
  // turns the model's own sentence into calls it never made — and the next
  // request then declares more calls than it has results for.
  let history: Message[] = [
    userMessage("what does the marker mean?"),
    assistantMessage("a turn records itself as [tool_calls] weather({\"input\":\"Paris\"}), which I am only describing\n[tool_calls] clock({\"input\":\"UTC\"})"),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"message\":" + emitChatTurn(turns[1]) + "}]}";
  let back = parseToolCalls(responseLike);
  expect(back.length == 1);
  expect(back[0].name == "clock");
  expect(toolCallInput(back[0]) == "UTC");
  // and the sentence itself is still in the prose the model sent.
  expect(turns[1].content.indexOf("only describing") >= 0);
});

test("an assistant answer quoting the marker declares no calls at all", () => {
  let history: Message[] = [
    userMessage("what does the marker mean?"),
    assistantMessage("the loop writes [tool_calls] name(args) at the end of a turn."),
  ];
  let turns = agentHistoryToTurns(history);
  expect(turns.length == 2);
  expect(turns[1].tool_calls == "");
  let responseLike = "{\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":" + emitChatTurn(turns[1]) + "}]}";
  expect(parseToolCalls(responseLike).length == 0);
});

test("a history whose prose quotes the marker does not skip a scripted turn", () => {
  let script: string[] = [agentFakeToolCall("weather", "Paris"), agentFakeAnswer("18C in Paris")];
  let history: Message[] = [
    userMessage("weather in Paris, and what is [tool_calls]?"),
    assistantMessage("I have not used [tool_calls] yet."),
    userMessage("go on"),
  ];
  let result = runAgent(fakeModel(script), agSampleTools(), history, 5);
  expect(result.steps.length == 1);
  expect(result.steps[0].tool == "weather");
  expect(result.answer == "18C in Paris");
});

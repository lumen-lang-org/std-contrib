// the live tool-calling adapter: serialized tool definitions plus a turn history
// carrying native `tool_calls` and `tool_call_id`. Message holds only
// role+content, so it cannot carry the `tool_call_id` an OpenAI follow-up
// requires — hence the superset turn record below.

import { makeTool, runTool } from "./tools.ts";
import { serializeToolDefs, serializeToolDefsMistral, parseToolCalls, toolCallInput, makeToolCall } from "./toolcall.ts";
import { systemMessage, userMessage } from "../core/messages.ts";
import { bearerJsonHeaders } from "../core/headers.ts";

// a superset of Message; absent fields are "". one shape covers a plain turn,
// an assistant turn that asked for tools (`tool_calls` holds the native array
// fragment), and a tool-result turn (`tool_call_id` matches an id in the
// preceding assistant turn). declared without `export`; module inlining exposes
// it to importers.
export type ChatTurn = {
  role: string,
  content: string,
  tool_call_id: string,
  name: string,
  tool_calls: string,
};

// the scalar half of a chat request body. `messages` and `tools` are emitted by
// hand (fields are omitted per role), but the scalars go through JSON.stringify
// so a float temperature needs no hand-rolled number formatting.
type ChatBodyScalars = {
  model: string,
  temperature: number,
  max_tokens: int,
};

// the fragment parameter is `toolCallsFrag`, not `toolCalls`: the barrel (ai.ts)
// exports a top-level `toolCalls` and inlines this module, so that name would
// shadow the declaration and the native backend rejects the generated code.
function chatTurn(role: string, content: string, toolCallId: string, name: string, toolCallsFrag: string): ChatTurn {
  let t: ChatTurn = {
    role: role,
    content: content,
    tool_call_id: toolCallId,
    name: name,
    tool_calls: toolCallsFrag,
  };
  return t;
}

// each `arguments` value is itself a JSON string, so it is re-escaped with
// JSON.stringify rather than concatenated raw, as are the id and name.
function nativeToolCalls(calls: ToolCall[]): string {
  let out = "[";
  let i: int = 0;
  while (i < calls.length) {
    if (i > 0) { out = out + ","; }
    out = out + "{\"id\":" + JSON.stringify(calls[i].id)
      + ",\"type\":\"function\",\"function\":{\"name\":" + JSON.stringify(calls[i].name)
      + ",\"arguments\":" + JSON.stringify(calls[i].arguments) + "}}";
    i = i + 1;
  }
  return out + "]";
}

// one emitted message; fields are omitted per role. every string is escaped with
// JSON.stringify, but the `tool_calls` fragment is already valid JSON and is
// concatenated verbatim.
export function emitChatTurn(turn: ChatTurn): string {
  if (turn.role == "tool") {
    return "{\"role\":\"tool\",\"tool_call_id\":" + JSON.stringify(turn.tool_call_id)
      + ",\"content\":" + JSON.stringify(turn.content) + "}";
  }
  if (turn.tool_calls != "") {
    return "{\"role\":" + JSON.stringify(turn.role)
      + ",\"content\":" + JSON.stringify(turn.content)
      + ",\"tool_calls\":" + turn.tool_calls + "}";
  }
  return "{\"role\":" + JSON.stringify(turn.role)
    + ",\"content\":" + JSON.stringify(turn.content) + "}";
}

export function emitChatMessages(turns: ChatTurn[]): string {
  let out = "[";
  let i: int = 0;
  while (i < turns.length) {
    if (i > 0) { out = out + ","; }
    out = out + emitChatTurn(turns[i]);
    i = i + 1;
  }
  return out + "]";
}

// tool metadata is empty, so this emits as a bare `{role, content}` message.
export function messageTurn(msg: Message): ChatTurn {
  return chatTurn(msg.role, msg.content, "", "", "");
}

// `calls` become the native `tool_calls` fragment whose ids every following tool
// turn must match.
export function assistantToolCallsTurn(content: string, calls: ToolCall[]): ChatTurn {
  return chatTurn("assistant", content, "", "", nativeToolCalls(calls));
}

// `toolCallId` ties this back to a call in the preceding assistant turn — the
// association OpenAI requires and plain role="tool" text cannot carry. a failure
// takes the same shape as a success.
export function toolResultTurn(toolCallId: string, result: ToolResult): ChatTurn {
  let body = result.output;
  if (!result.ok) { body = "error: " + result.error; }
  return chatTurn("tool", body, toolCallId, result.name, "");
}

// lift a neutral-text history into turn records. nothing carries tool metadata
// yet; the loop appends assistant/tool turns as calls happen.
export function toChatTurns(messages: Message[]): ChatTurn[] {
  let out: ChatTurn[] = [];
  let i: int = 0;
  while (i < messages.length) {
    out.push(messageTurn(messages[i]));
    i = i + 1;
  }
  return out;
}

// an empty registry omits the `tools` field entirely rather than sending
// `"tools":[]`, which some providers reject. this only concatenates, so it never
// throws.
function buildToolBody(model: string, turns: ChatTurn[], frag: string, temperature: number, maxTokens: int): string {
  let scalars: ChatBodyScalars = {
    model: model,
    temperature: temperature,
    max_tokens: maxTokens,
  };
  let head = JSON.stringify(scalars);
  let inner = head.slice(1, head.length - 1);
  let body = "{" + inner + ",\"messages\":" + emitChatMessages(turns);
  if (frag != "[]") { body = body + ",\"tools\":" + frag; }
  return body + "}";
}

export function buildOpenAIToolBody(model: string, turns: ChatTurn[], tools: Tool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefs(tools), temperature, maxTokens);
}

// mistral takes the same OpenAI-compatible body; separate entry point so the two
// can diverge later without moving callers.
export function buildMistralToolBody(model: string, turns: ChatTurn[], tools: Tool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefsMistral(tools), temperature, maxTokens);
}

// the only I/O in this module; it hands back the raw response body for the
// caller to read with parseToolCalls/finishReason, keeping the rest offline.
export function runOpenAIToolChat(apiKey: string, model: string, turns: ChatTurn[], tools: Tool[]): string {
  const body = buildOpenAIToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.openai.com/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}

export function runMistralToolChat(apiKey: string, model: string, turns: ChatTurn[], tools: Tool[]): string {
  const body = buildMistralToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.mistral.ai/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}



// exact-shape types used only by the tests: JSON.parse throws on any unknown or
// missing field, which is what proves an emitted body has the provider's shape.
type ChatPlainMsgT = {
  role: string,
  content: string,
};

type ChatPlainBodyT = {
  model: string,
  temperature: number,
  max_tokens: int,
  messages: ChatPlainMsgT[],
};

type ChatCallFnT = {
  name: string,
  arguments: string,
};

type ChatCallEntryT = {
  id: string,
  type: string,
  function: ChatCallFnT,
};

type ChatAssistantMsgT = {
  role: string,
  content: string,
  tool_calls: ChatCallEntryT[],
};

type ChatToolMsgT = {
  role: string,
  tool_call_id: string,
  content: string,
};

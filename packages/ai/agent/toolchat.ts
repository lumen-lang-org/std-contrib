// The live tool-calling adapter: it carries the serialized tool definitions in a
// chat request body and serializes a turn history — including native
// `tool_calls` and `tool_call_id` — into the provider's `messages` array. This
// is the round trip the neutral-text agent loop cannot do on its own: a
// AiMessage carries only role+content, so it provably cannot hold the
// `tool_call_id` an OpenAI follow-up request requires. A superset turn record is
// therefore necessary, not optional.

import { makeTool, runTool } from "./tools.ts";
import { serializeToolDefs, serializeToolDefsMistral, parseToolCalls, toolCallInput, makeToolCall } from "./toolcall.ts";
import { systemMessage, userMessage } from "../core/messages.ts";
import { bearerJsonHeaders } from "../core/headers.ts";

// A superset of AiMessage. Absent fields are the empty string, so one
// record shape covers a plain user turn, an assistant turn that asked for tools
// (`tool_calls` holds the native array fragment), and a tool-result turn
// (`tool_call_id` matches an id in the preceding assistant turn). Declared
// without `export`; module inlining exposes it to importers.
type AiChatTurn = {
  role: string,
  content: string,
  tool_call_id: string,
  name: string,
  tool_calls: string,
};

// The scalar half of a chat request body. The `messages` and `tools` arrays are
// emitted by hand — messages omit fields per role, and the tools array comes
// straight from serializeToolDefs — but the scalars go through JSON.stringify so
// a float temperature is formatted the same way the rest of the package formats
// it, with no hand-rolled number-to-string step.
type ChatBodyScalars = {
  model: string,
  temperature: number,
  max_tokens: int,
};

// The `toolCalls` fragment parameter is named `toolCallsFrag`, not `toolCalls`,
// because the barrel (ai.ts) exports a top-level `toolCalls` function and inlines
// this module: a parameter named `toolCalls` would shadow that declaration and
// the native backend rejects the generated code.
function chatTurn(role: string, content: string, toolCallId: string, name: string, toolCallsFrag: string): AiChatTurn {
  let t: AiChatTurn = {
    role: role,
    content: content,
    tool_call_id: toolCallId,
    name: name,
    tool_calls: toolCallsFrag,
  };
  return t;
}

// Rebuild the assistant `tool_calls` array from parsed calls. Each `arguments`
// value is itself a JSON string, so it is re-escaped with JSON.stringify rather
// than concatenated raw — otherwise a payload like {"input":"São Paulo"} would
// break the body. The id and name go through JSON.stringify for the same reason.
function nativeToolCalls(calls: AiToolCall[]): string {
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

// One emitted message, branching on role and omitting empty fields:
//   tool                    -> role, tool_call_id, content
//   assistant with calls    -> role, content, tool_calls (fragment, not escaped)
//   anything else           -> role, content
// Every string value is escaped with JSON.stringify; the `tool_calls` fragment
// is already valid JSON and is concatenated verbatim.
export function emitChatTurn(turn: AiChatTurn): string {
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

export function emitChatMessages(turns: AiChatTurn[]): string {
  let out = "[";
  let i: int = 0;
  while (i < turns.length) {
    if (i > 0) { out = out + ","; }
    out = out + emitChatTurn(turns[i]);
    i = i + 1;
  }
  return out + "]";
}

// A plain turn lifted from ordinary chat history. Tool metadata is empty, so it
// emits as a bare `{role, content}` message.
export function messageTurn(msg: AiMessage): AiChatTurn {
  return chatTurn(msg.role, msg.content, "", "", "");
}

// The assistant turn that asked for tools. `content` is whatever prose the model
// produced alongside the calls (often empty); `calls` become the native
// `tool_calls` fragment every following tool turn's id must match.
export function assistantToolCallsTurn(content: string, calls: AiToolCall[]): AiChatTurn {
  return chatTurn("assistant", content, "", "", nativeToolCalls(calls));
}

// A tool-result turn. `toolCallId` ties it back to a call in the preceding
// assistant turn — the association OpenAI requires and that plain role="tool"
// text cannot carry. A failed dispatch is reported to the model in the same
// shape as a success, matching toolResultMessage's one-path rule.
export function toolResultTurn(toolCallId: string, result: AiToolResult): AiChatTurn {
  let body = result.output;
  if (!result.ok) { body = "error: " + result.error; }
  return chatTurn("tool", body, toolCallId, result.name, "");
}

// Lift a plain neutral-text history into turn records so it can seed a tool
// round trip. Nothing here carries tool metadata yet; the assistant/tool turns
// are appended by the loop as calls happen.
export function toChatTurns(messages: AiMessage[]): AiChatTurn[] {
  let out: AiChatTurn[] = [];
  let i: int = 0;
  while (i < messages.length) {
    out.push(messageTurn(messages[i]));
    i = i + 1;
  }
  return out;
}

// Concatenate the scalars, the emitted messages array, and — only when the
// registry is non-empty — the serialized tools array. An empty registry omits
// the `tools` field entirely rather than sending `"tools":[]`, which some
// providers reject. Build only concatenates, so it never throws.
function buildToolBody(model: string, turns: AiChatTurn[], frag: string, temperature: number, maxTokens: int): string {
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

export function buildOpenAIToolBody(model: string, turns: AiChatTurn[], tools: AiTool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefs(tools), temperature, maxTokens);
}

// Mistral takes the same OpenAI-compatible body, so this only differs in which
// serializer it calls — leaving room for the two to diverge later without
// moving every caller.
export function buildMistralToolBody(model: string, turns: AiChatTurn[], tools: AiTool[], temperature: number, maxTokens: int): string {
  return buildToolBody(model, turns, serializeToolDefsMistral(tools), temperature, maxTokens);
}

// The one function in this module that does I/O. It stays thin — build the body,
// POST it, hand back the raw response body — so the caller parses tool calls or
// the final answer with parseToolCalls/finishReason, and everything else in the
// module is offline-testable.
export function runOpenAIToolChat(apiKey: string, model: string, turns: AiChatTurn[], tools: AiTool[]): string {
  const body = buildOpenAIToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.openai.com/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}

export function runMistralToolChat(apiKey: string, model: string, turns: AiChatTurn[], tools: AiTool[]): string {
  const body = buildMistralToolBody(model, turns, tools, 0.7, 1024);
  const res = http.request("https://api.mistral.ai/v1/chat/completions", "POST", body, bearerJsonHeaders(apiKey));
  return res.body;
}



// Exact-shape types used only to prove — via JSON.parse, which throws on any
// unknown or missing field — that an emitted body/message is genuinely valid
// JSON of the shape the provider expects.
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

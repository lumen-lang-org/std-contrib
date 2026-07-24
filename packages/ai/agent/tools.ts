// Tool registry, dispatch, and the allow/deny policy around a tool call.

import { systemMessage } from "../core/messages.ts";

type AiTool = {
  name: string,
  description: string,
  params: string,
  run: (input: string) => string,
};

type AiToolResult = {
  name: string,
  input: string,
  output: string,
  ok: bool,
  error: string,
};

function toolOk(name: string, input: string, output: string): AiToolResult {
  let res: AiToolResult = {
    name: name,
    input: input,
    output: output,
    ok: true,
    error: "",
  };
  return res;
}

function toolFailure(name: string, input: string, message: string): AiToolResult {
  let res: AiToolResult = {
    name: name,
    input: input,
    output: "",
    ok: false,
    error: message,
  };
  return res;
}

// An allow/deny entry and the name actually being dispatched are compared under
// a canonical form (surrounding whitespace stripped, ASCII case folded), not by
// raw string equality. Otherwise a deny only blocks the exact spelling it was
// written with, and any registered tool whose name differs from the deny entry
// by case or padding — "Shell" or "shell " against deny ["shell"] — runs despite
// a deny meant to cover it. Dispatch (findTool) still matches the registry
// exactly; this only governs whether policy applies to that dispatch.
function toolCanonical(name: string): string {
  return name.trim().toLowerCase();
}

function toolListHas(names: string[], name: string): bool {
  let target = toolCanonical(name);
  for (const item of names) {
    if (toolCanonical(item) == target) { return true; }
  }
  return false;
}

// The tool description block is one line per tool, so a newline inside a name,
// a params note, or a description would forge a whole extra tool line and let a
// user-authored tool advertise capabilities the registry does not have. Every
// field is flattened to a single line before it is rendered. Tabs go too, so a
// pasted description cannot fake column alignment.
function toolFlattenLine(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charAt(i);
    if (c == "\n" || c == "\r" || c == "\t") {
      out = out + " ";
    } else {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

// The names a dispatch failure may mention, so the model is told what it could
// have called instead of only that it guessed wrong.
function toolNameList(tools: AiTool[]): string {
  let out = "";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) { out = out + ", "; }
    out = out + toolFlattenLine(tools[i].name);
    i = i + 1;
  }
  return out;
}

export function makeTool(name: string, description: string, params: string, run: (input: string) => string): AiTool {
  return {
    name: name,
    description: description,
    params: params,
    run: run,
  };
}

export function toolRegistry(): AiTool[] {
  let empty: AiTool[] = [];
  return empty;
}

// Registering a name that is already present replaces it in place rather than
// appending, because two tools sharing a name would make every later lookup
// pick whichever one happened to be first and silently ignore the other.
export function registerTool(tools: AiTool[], tool: AiTool): AiTool[] {
  let at = findTool(tools, tool.name);
  if (at < 0) { return [...tools, tool]; }
  return [...tools.slice(0, at), tool, ...tools.slice(at + 1, tools.length)];
}

export function findTool(tools: AiTool[], name: string): int {
  let i: int = 0;
  while (i < tools.length) {
    if (tools[i].name == name) { return i; }
    i = i + 1;
  }
  return -1;
}

export function hasTool(tools: AiTool[], name: string): bool {
  return findTool(tools, name) >= 0;
}

export function toolNames(tools: AiTool[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(tools[i].name);
    i = i + 1;
  }
  return out;
}

// The block a system prompt carries so the model knows what it may call. An
// empty registry renders as an empty string, which lets the caller drop the
// whole section instead of telling the model about a list that is not there.
export function describeTools(tools: AiTool[]): string {
  let out = "";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) { out = out + "\n"; }
    out = out + "- " + toolFlattenLine(tools[i].name);
    out = out + "(" + toolFlattenLine(tools[i].params) + ")";
    out = out + ": " + toolFlattenLine(tools[i].description);
    i = i + 1;
  }
  return out;
}

// A model asking for a tool that does not exist is an ordinary event, not a
// crash: the failure comes back as a result the agent loop can hand straight
// back to the model so it can pick a real name on the next step.
export function runTool(tools: AiTool[], name: string, input: string): AiToolResult {
  let at = findTool(tools, name);
  if (at < 0) {
    if (tools.length == 0) {
      return toolFailure(name, input, "unknown tool \"" + toolFlattenLine(name) + "\": no tools are registered");
    }
    return toolFailure(name, input, "unknown tool \"" + toolFlattenLine(name) + "\": available tools are " + toolNameList(tools));
  }
  // A tool function cannot be declared throwing today — the compiler rejects
  // assigning one to the `run` field — so a tool reports trouble by returning
  // text. The guard stays so a future throwing tool degrades into a result
  // instead of unwinding through the agent loop.
  try {
    return toolOk(name, input, tools[at].run(input));
  } catch (err) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" failed");
  }
}

// Policy is checked before the registry is even consulted, so a denied name is
// never dispatched and the caller learns nothing about whether it exists. Deny
// wins over allow: a name on both lists is blocked. An empty allow list means
// everything that is not denied.
export function runToolWithPolicy(tools: AiTool[], allow: string[], deny: string[], name: string, input: string): AiToolResult {
  if (toolListHas(deny, name)) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" is blocked by policy: denied");
  }
  if (allow.length > 0 && !toolListHas(allow, name)) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" is blocked by policy: not in the allow list");
  }
  return runTool(tools, name, input);
}

// The message that carries a tool result back into the conversation. A failure
// is reported to the model in the same shape as a success so the loop has one
// path: the model reads the error and decides what to do next.
export function toolResultMessage(result: AiToolResult): AiMessage {
  let body = result.output;
  if (!result.ok) { body = "error: " + result.error; }
  let msg: AiMessage = {
    role: "tool",
    content: "[tool " + toolFlattenLine(result.name) + "] " + body,
  };
  return msg;
}

// A tool body is an ordinary named function as readily as a lambda; the
// registry only cares about the shape.
function toolShoutBody(input: string): string {
  return input.toUpperCase();
}

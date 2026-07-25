// Tool registry, dispatch, and the allow/deny policy around a tool call.

import { systemMessage } from "../core/messages.ts";

export type Tool = {
  name: string,
  description: string,
  params: string,
  run: (input: string) => string,
};

export type ToolResult = {
  name: string,
  input: string,
  output: string,
  ok: bool,
  error: string,
};

function toolOk(name: string, input: string, output: string): ToolResult {
  let res: ToolResult = {
    name: name,
    input: input,
    output: output,
    ok: true,
    error: "",
  };
  return res;
}

function toolFailure(name: string, input: string, message: string): ToolResult {
  let res: ToolResult = {
    name: name,
    input: input,
    output: "",
    ok: false,
    error: message,
  };
  return res;
}

// policy compares names canonically (trimmed, case folded) so a deny entry also
// blocks "Shell" and "shell ". dispatch (findTool) still matches exactly.
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

// the description block is one line per tool, so a newline or tab in any field
// would forge an extra tool line advertising a tool the registry does not have.
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

function toolNameList(tools: Tool[]): string {
  let out = "";
  let i: int = 0;
  while (i < tools.length) {
    if (i > 0) { out = out + ", "; }
    out = out + toolFlattenLine(tools[i].name);
    i = i + 1;
  }
  return out;
}

export function makeTool(name: string, description: string, params: string, run: (input: string) => string): Tool {
  return {
    name: name,
    description: description,
    params: params,
    run: run,
  };
}

export function toolRegistry(): Tool[] {
  let empty: Tool[] = [];
  return empty;
}

// a name already present is replaced in place; two tools sharing a name would
// leave every later lookup silently picking the first.
// `entry` rather than `tool`: a parameter shares one namespace with every
// top-level name in the program, so calling it `tool` would collide with any
// module that exports a function of that name — the @tool decorator does.
export function registerTool(tools: Tool[], entry: Tool): Tool[] {
  let at = findTool(tools, entry.name);
  if (at < 0) { return [...tools, entry]; }
  return [...tools.slice(0, at), entry, ...tools.slice(at + 1, tools.length)];
}

export function findTool(tools: Tool[], name: string): int {
  let i: int = 0;
  while (i < tools.length) {
    if (tools[i].name == name) { return i; }
    i = i + 1;
  }
  return -1;
}

export function hasTool(tools: Tool[], name: string): bool {
  return findTool(tools, name) >= 0;
}

export function toolNames(tools: Tool[]): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < tools.length) {
    out.push(tools[i].name);
    i = i + 1;
  }
  return out;
}

// the tool block a system prompt carries. an empty registry renders as "", so
// the caller can drop the whole section.
export function describeTools(tools: Tool[]): string {
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

// an unknown tool is an ordinary failed result, not a crash: the loop hands it
// back to the model so it can pick a real name next step.
export function runTool(tools: Tool[], name: string, input: string): ToolResult {
  let at = findTool(tools, name);
  if (at < 0) {
    if (tools.length == 0) {
      return toolFailure(name, input, "unknown tool \"" + toolFlattenLine(name) + "\": no tools are registered");
    }
    return toolFailure(name, input, "unknown tool \"" + toolFlattenLine(name) + "\": available tools are " + toolNameList(tools));
  }
  // a tool cannot be declared throwing today (the compiler rejects it on `run`),
  // so tools report trouble as text; the guard is for a future throwing tool.
  try {
    return toolOk(name, input, tools[at].run(input));
  } catch (err) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" failed");
  }
}

// policy is checked before the registry is consulted, so a denied name is never
// dispatched and leaks nothing about whether it exists. deny wins over allow; an
// empty allow list means everything not denied.
export function runToolWithPolicy(tools: Tool[], allow: string[], deny: string[], name: string, input: string): ToolResult {
  if (toolListHas(deny, name)) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" is blocked by policy: denied");
  }
  if (allow.length > 0 && !toolListHas(allow, name)) {
    return toolFailure(name, input, "tool \"" + toolFlattenLine(name) + "\" is blocked by policy: not in the allow list");
  }
  return runTool(tools, name, input);
}

// carries a tool result back into the conversation. a failure takes the same
// shape as a success so the loop has one path.
export function toolResultMessage(result: ToolResult): Message {
  let body = result.output;
  if (!result.ok) { body = "error: " + result.error; }
  let msg: Message = {
    role: "tool",
    content: "[tool " + toolFlattenLine(result.name) + "] " + body,
  };
  return msg;
}

// test fixture: a tool body may be a named function, not only a lambda.
function toolShoutBody(input: string): string {
  return input.toUpperCase();
}

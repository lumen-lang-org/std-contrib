// The @tool decorator, tested by calling it.
//
// The second case spec 455 is meant to serve, and the one that decides whether
// the design is shaped around a single example. It found a real edge: a `Tool`
// carries a function, and no returned value can, so the decorator returns the
// schema and the program supplies the behaviour.
//
//   cd packages/ai/agent && lumen test toolschema.test.ts

import { FunctionDescription, ParamDescription, ToolDecoratorUse, ToolSchema, tool, toolFrom, toolProblem, parameterSchema, jsonSchemaType, paramArg } from "./toolschema.ts";
import { runTool, toolRegistry, registerTool, findTool } from "../ai.ts";

function on(name: string, args: string[]): ToolDecoratorUse {
  let u: ToolDecoratorUse = { name: name, args: args };
  return u;
}

function param(name: string, declared: string, decorators: ToolDecoratorUse[]): ParamDescription {
  let p: ParamDescription = { name: name, type: declared, decorators: decorators };
  return p;
}

// What the compiler would hand @tool for:
//
//   @tool("search the archive for a phrase")
//   function searchArchive(@param("the phrase to look for") query: string,
//                          @param("how many results") limit: int): string
function searchDescription(): FunctionDescription {
  let params: ParamDescription[] = [
    param("query", "string", [on("param", ["the phrase to look for"])]),
    param("limit", "int", [on("param", ["how many results"])]),
  ];
  let d: FunctionDescription = {
    protocol: 1, kind: "function", name: "searchArchive",
    args: ["search the archive for a phrase"],
    file: "search.ts", line: 4, params: params, returns: "string",
  };
  return d;
}

test("a decorated function becomes a tool schema", () => {
  let s = tool(searchDescription());
  expect(s.name == "searchArchive");
  expect(s.description == "search the archive for a phrase");
  expect(s.parameters.indexOf("\"query\"") >= 0);
  expect(s.parameters.indexOf("\"limit\"") >= 0);
});

test("the parameter schema is JSON a model can read", () => {
  let s = tool(searchDescription());
  let schema = s.parameters;
  expect(schema.indexOf("\"type\":\"object\"") >= 0);
  expect(schema.indexOf("\"query\":{\"type\":\"string\",\"description\":\"the phrase to look for\"}") >= 0);
  expect(schema.indexOf("\"limit\":{\"type\":\"integer\",\"description\":\"how many results\"}") >= 0);
  // Every parameter is required, because a Lumen function has no optional ones
  // and saying otherwise would describe a function that does not exist.
  expect(schema.indexOf("\"required\":[\"query\",\"limit\"]") >= 0);
});

test("a declared type maps to what JSON Schema calls it", () => {
  expect(jsonSchemaType("int") == "integer");
  expect(jsonSchemaType("i64") == "integer");
  expect(jsonSchemaType("number") == "number");
  expect(jsonSchemaType("bool") == "boolean");
  expect(jsonSchemaType("string") == "string");
  expect(jsonSchemaType("string[]") == "array");
  // Anything unrecognised reads as a string: a model chooses by the
  // description, and a wrong type is worse than a vague one.
  expect(jsonSchemaType("Agent") == "string");
});

test("an array parameter carries its element type", () => {
  let params: ParamDescription[] = [
    param("terms", "string[]", [on("param", ["the words to match"])]),
  ];
  let d: FunctionDescription = {
    protocol: 1, kind: "function", name: "matchAny", args: ["match any of the words"],
    file: "m.ts", line: 1, params: params, returns: "string",
  };
  let schema = parameterSchema(d);
  expect(schema.indexOf("\"type\":\"array\"") >= 0);
  expect(schema.indexOf("\"items\":{\"type\":\"string\"}") >= 0);
});

test("a function with no parameters still produces a valid schema", () => {
  let none: ParamDescription[] = [];
  let d: FunctionDescription = {
    protocol: 1, kind: "function", name: "now", args: ["the current time"],
    file: "t.ts", line: 1, params: none, returns: "string",
  };
  let schema = parameterSchema(d);
  expect(schema == "{\"type\":\"object\",\"properties\":{},\"required\":[]}");
});

test("a description or name containing a quote stays valid JSON", () => {
  let params: ParamDescription[] = [
    param("query", "string", [on("param", ["the \"exact\" phrase"])]),
  ];
  let d: FunctionDescription = {
    protocol: 1, kind: "function", name: "q", args: ["a \"quoted\" tool"],
    file: "q.ts", line: 1, params: params, returns: "string",
  };
  let schema = parameterSchema(d);
  expect(schema.indexOf("\\\"exact\\\"") >= 0);
});

test("a schema pairs with a function to make a working tool", () => {
  let s = tool(searchDescription());
  let entry = toolFrom(s, (input: string) => { return "found: " + input; });
  let tools = registerTool(toolRegistry(), entry);
  expect(findTool(tools, "searchArchive") >= 0);
  let result = runTool(tools, "searchArchive", "lumen");
  expect(result.ok);
  expect(result.output == "found: lumen");
});

// --- what it refuses -------------------------------------------------------

test("a well-formed description reports no problem", () => {
  expect(toolProblem(searchDescription()) == "");
});

test("a protocol it does not know is refused", () => {
  let d = searchDescription();
  let future: FunctionDescription = {
    protocol: 2, kind: d.kind, name: d.name, args: d.args,
    file: d.file, line: d.line, params: d.params, returns: d.returns,
  };
  expect(toolProblem(future).indexOf("protocol 1") >= 0);
});

test("a tool that does not return a string is refused, naming it", () => {
  let d = searchDescription();
  let wrong: FunctionDescription = {
    protocol: d.protocol, kind: d.kind, name: "searchArchive", args: d.args,
    file: d.file, line: d.line, params: d.params, returns: "int",
  };
  let problem = toolProblem(wrong);
  expect(problem.indexOf("searchArchive") >= 0);
  expect(problem.indexOf("returns a string") >= 0);
});

test("a parameter with no description is refused, because the model reads it", () => {
  let none: ToolDecoratorUse[] = [];
  let params: ParamDescription[] = [param("query", "string", none)];
  let d: FunctionDescription = {
    protocol: 1, kind: "function", name: "searchArchive", args: ["search"],
    file: "s.ts", line: 1, params: params, returns: "string",
  };
  let problem = toolProblem(d);
  expect(problem.indexOf("\"query\"") >= 0);
  expect(problem.indexOf("@param") >= 0);
});

test("a missing tool description is refused", () => {
  let d = searchDescription();
  let empty: string[] = [];
  let bare: FunctionDescription = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: empty,
    file: d.file, line: d.line, params: d.params, returns: d.returns,
  };
  expect(toolProblem(bare).indexOf("a description the model will read") >= 0);
});

test("a class description is refused, since @tool goes on a function", () => {
  let d = searchDescription();
  let wrongKind: FunctionDescription = {
    protocol: d.protocol, kind: "class", name: d.name, args: d.args,
    file: d.file, line: d.line, params: d.params, returns: d.returns,
  };
  expect(toolProblem(wrongKind).indexOf("goes on a function") >= 0);
});

test("a decorator argument is read by name and position", () => {
  let d = searchDescription();
  expect(paramArg(d.params[0], "param", 0) == "the phrase to look for");
  expect(paramArg(d.params[0], "param", 7) == "");
  expect(paramArg(d.params[0], "absent", 0) == "");
});

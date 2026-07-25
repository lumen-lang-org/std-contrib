// The `@tool` decorator: a tool's schema derived from the function it
// describes, so the parameters are stated once instead of twice.
//
//   @tool("search the web for a phrase")
//   function searchWeb(@param("the phrase to search for") query: string): string {
//     ...
//   }
//
//   let tools = registerTool(toolRegistry(), toolFrom(toolSearchWeb, searchWeb));
//
// This is the second case spec 455 is meant to serve, and it found the design's
// real edge: a decorator returns a value, and a `Tool` carries a function,
// which no value can. So the decorator returns the schema — the part that is
// data — and the program pairs it with the function, which it already has. A
// decorator derives what can be derived; it does not conjure the behaviour.

import { defineTool } from "../ai.ts";
import { Tool } from "./tools.ts";

// --- the description the compiler passes in --------------------------------
//
// Declared here rather than imported because spec 455 is not landed yet. The
// function-shaped description: `params` and `returns` where a class-shaped one
// has `fields`.

export type ToolDecoratorUse = {
  name: string,
  args: string[],
};

export type ParamDescription = {
  name: string,
  type: string,
  decorators: ToolDecoratorUse[],
};

export type FunctionDescription = {
  protocol: int,
  kind: string,
  name: string,
  args: string[],
  file: string,
  line: int,
  params: ParamDescription[],
  returns: string,
};

// What a tool needs that is data: everything except the behaviour.
export type ToolSchema = {
  name: string,
  description: string,
  parameters: string,
};

// --- deriving the schema ---------------------------------------------------

export function paramArg(p: ParamDescription, name: string, index: int): string {
  let i: int = 0;
  while (i < p.decorators.length) {
    if (p.decorators[i].name == name) {
      if (index < p.decorators[i].args.length) { return p.decorators[i].args[index]; }
      return "";
    }
    i = i + 1;
  }
  return "";
}

// A declared type as JSON Schema spells it. An unrecognised annotation becomes
// a string, because a model reads the description rather than the type, and a
// wrong type is worse than a vague one.
export function jsonSchemaType(declared: string): string {
  if (declared == "int" || declared == "i32" || declared == "i64") { return "integer"; }
  if (declared == "number" || declared == "f64") { return "number"; }
  if (declared == "bool" || declared == "boolean") { return "boolean"; }
  if (declared.endsWith("[]")) { return "array"; }
  return "string";
}

function jsonString(text: string): string {
  return JSON.stringify(text);
}

// The parameters as a JSON Schema object. Every parameter is required: a
// Lumen function has no optional ones, so saying otherwise would describe a
// function that does not exist.
export function parameterSchema(d: FunctionDescription): string {
  let props = "";
  let required = "";
  let i: int = 0;
  while (i < d.params.length) {
    let p = d.params[i];
    if (i > 0) { props = props + ","; required = required + ","; }
    let described = paramArg(p, "param", 0);
    let entry = "\"type\":" + jsonString(jsonSchemaType(p.type));
    if (described != "") { entry = entry + ",\"description\":" + jsonString(described); }
    if (jsonSchemaType(p.type) == "array") {
      // An array's element type is the annotation with the brackets removed,
      // which is the only shape a tool parameter can carry.
      let element = p.type.substring(0, p.type.length - 2);
      entry = entry + ",\"items\":{\"type\":" + jsonString(jsonSchemaType(element)) + "}";
    }
    props = props + jsonString(p.name) + ":{" + entry + "}";
    required = required + jsonString(p.name);
    i = i + 1;
  }
  return "{\"type\":\"object\",\"properties\":{" + props + "},\"required\":[" + required + "]}";
}

export function tool(d: FunctionDescription): ToolSchema {
  let description = "";
  if (d.args.length > 0) { description = d.args[0]; }
  let s: ToolSchema = {
    name: d.name,
    description: description,
    parameters: parameterSchema(d),
  };
  return s;
}

// Pair a derived schema with the function it describes. The decorator supplies
// everything about a tool except what it does.
export function toolFrom(schema: ToolSchema, run: (input: string) => string): Tool {
  return defineTool(schema.name, schema.description, schema.parameters, run);
}

// Why a description would not make a usable tool.
export function toolProblem(d: FunctionDescription): string {
  if (d.protocol != 1) {
    return "this decorator understands description protocol 1, not " + `${d.protocol}`;
  }
  if (d.kind != "function") {
    return "@tool goes on a function, not on a " + d.kind;
  }
  if (d.args.length == 0 || d.args[0] == "") {
    return "@tool needs a description the model will read: @tool(\"search the web\")";
  }
  if (d.returns != "string") {
    return d.name + " returns " + d.returns + ", and a tool returns a string";
  }
  let i: int = 0;
  while (i < d.params.length) {
    if (paramArg(d.params[i], "param", 0) == "") {
      return "the parameter \"" + d.params[i].name + "\" of " + d.name
        + " has no @param description, and a model chooses arguments by reading them";
    }
    i = i + 1;
  }
  return "";
}

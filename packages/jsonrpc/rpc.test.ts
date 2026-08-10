import { rpc, Description, RpcMethodNote, RpcDecoratorUse, RpcRoute, tableFault, handlerFor, envelopeOf, jsonObjectOf, jsonArrayOf, rpcOk, rpcRaw, answered, refused, METHOD_NOT_FOUND, INVALID_REQUEST, PARSE_ERROR, INVALID_PARAMS, INTERNAL_ERROR } from "./rpc.ts";

type Info = { name: string, version: string };

function on(name: string, args: string[]): RpcDecoratorUse { return { name: name, args: args }; }
function m(name: string, decs: RpcDecoratorUse[]): RpcMethodNote {
  return { name: name, returns: "RpcReply", decorators: decs };
}
function describe(methods: RpcMethodNote[]): Description {
  return { protocol: 1, kind: "class", name: "McpApi", args: [], fields: [], methods: methods };
}

test("the decorator turns @method into a table", () => {
  let table = rpc(describe([
    m("initialize", [on("method", ["initialize"])]),
    m("list", [on("method", ["tools/list"])]),
    m("helper", []),
  ]));
  expect(table.length == 2);
  expect(table[0].method == "initialize" && table[0].handler == "initialize");
  expect(table[1].method == "tools/list" && table[1].handler == "list");
});

test("one handler may answer several methods", () => {
  let table = rpc(describe([
    m("ping", [on("method", ["ping"]), on("method", ["notifications/initialized"])]),
  ]));
  expect(table.length == 2);
  expect(handlerFor(table, "ping") == "ping");
  expect(handlerFor(table, "notifications/initialized") == "ping");
});

test("a method nothing answers has no handler", () => {
  let table = rpc(describe([m("list", [on("method", ["tools/list"])])]));
  expect(handlerFor(table, "tools/call") == "");
});

test("two handlers claiming one method is refused", () => {
  let table = rpc(describe([
    m("a", [on("method", ["tools/list"])]),
    m("b", [on("method", ["tools/list"])]),
  ]));
  expect(tableFault(table).indexOf("two methods answer") >= 0);
  expect(tableFault([]).indexOf("at least one") >= 0);
});

test("an envelope gives up its id, method and params", () => {
  let e = envelopeOf("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"x\"}}");
  expect(e.fault == "");
  expect(e.id == "7");
  expect(e.method == "tools/call");
  expect(e.params == "{\"name\":\"x\"}");
});

test("a string id keeps its quotes, because it is echoed verbatim", () => {
  let e = envelopeOf("{\"id\":\"abc\",\"method\":\"ping\"}");
  expect(e.id == "\"abc\"");
});

test("a missing id is null and a missing params is an empty object", () => {
  let e = envelopeOf("{\"method\":\"ping\"}");
  expect(e.id == "null");
  expect(e.params == "{}");
});

test("a body with no method is refused, and an empty one too", () => {
  expect(envelopeOf("{\"id\":1}").fault != "");
  expect(envelopeOf("").fault != "");
});

test("params holding a nested object survive whole", () => {
  let e = envelopeOf("{\"method\":\"m\",\"params\":{\"a\":{\"b\":[1,2]},\"c\":\"}\"}}");
  expect(e.params == "{\"a\":{\"b\":[1,2]},\"c\":\"}\"}");
});

test("a reply wraps the envelope once", () => {
  let info: Info = { name: "joule", version: "1" };
  expect(answered("7", rpcOk(info)) == "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"name\":\"joule\",\"version\":\"1\"}}");
});

test("a refusal carries the code and the reason", () => {
  let said = refused("\"abc\"", METHOD_NOT_FOUND, "no method named \"nope\"");
  expect(said.indexOf("\"id\":\"abc\"") >= 0);
  expect(said.indexOf("-32601") >= 0);
  expect(said.indexOf("no method named \\\"nope\\\"") >= 0);
  expect(refused("1", INVALID_REQUEST, "x").indexOf("-32600") >= 0);
});

test("a pre-serialised document goes in whole, not quoted", () => {
  let schema = "{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}";
  let tool = jsonObjectOf([
    { key: "name", json: JSON.stringify("search") },
    { key: "description", json: JSON.stringify("look it up") },
    { key: "inputSchema", json: schema },
  ]);
  expect(tool == "{\"name\":\"search\",\"description\":\"look it up\",\"inputSchema\":" + schema + "}");
  expect(tool.indexOf("\\\"type\\\"") < 0);
});

test("an array of documents keeps them documents", () => {
  expect(jsonArrayOf(["{\"a\":1}", "{\"a\":2}"]) == "[{\"a\":1},{\"a\":2}]");
  expect(jsonArrayOf([]) == "[]");
});

test("a raw reply is not stringified again", () => {
  expect(answered("null", rpcRaw("{\"tools\":[]}")) == "{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":{\"tools\":[]}}");
});

test("the codes are the ones JSON-RPC names", () => {
  expect(PARSE_ERROR == -32700);
  expect(INVALID_REQUEST == -32600);
  expect(METHOD_NOT_FOUND == -32601);
  expect(INVALID_PARAMS == -32602);
  expect(INTERNAL_ERROR == -32603);
});

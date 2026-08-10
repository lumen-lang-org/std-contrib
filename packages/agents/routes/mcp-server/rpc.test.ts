import { Db } from "../../../plume/driver.ts";
import { sqlite } from "../../../plume/sqlite.ts";
import { Reply, Request } from "../../../rest/server.ts";
import { McpServerApi } from "./controller.ts";

let database: Db = sqlite();

function asked(body: string): Request {
  let req: Request = {
    method: "POST",
    path: "/mcp-server",
    body: body,
    headers: new Map<string, string>(),
    params: new Map<string, string>(),
    query: new Map<string, string>(),
  };
  return req;
}

function answering(body: string): Reply {
  let api = new McpServerApi(database);
  return api.rpc(asked(body));
}

test("initialize answers the handshake byte for byte", () => {
  let said = answering("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}");
  expect(said.status == 200);
  expect(said.body == "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{"
    + "\"protocolVersion\":\"2024-11-05\","
    + "\"capabilities\":{\"tools\":{}},"
    + "\"serverInfo\":{\"name\":\"joule\",\"version\":\"1\"}}}");
});

test("ping and the initialized note answer an empty result", () => {
  expect(answering("{\"id\":2,\"method\":\"ping\"}").body
    == "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}");
  expect(answering("{\"id\":3,\"method\":\"notifications/initialized\"}").body
    == "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}");
});

test("a string id is echoed with its quotes, and a missing one is null", () => {
  expect(answering("{\"id\":\"abc\",\"method\":\"ping\"}").body
    == "{\"jsonrpc\":\"2.0\",\"id\":\"abc\",\"result\":{}}");
  expect(answering("{\"method\":\"ping\"}").body
    == "{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":{}}");
});

test("a method nobody answers is refused with -32601", () => {
  let said = answering("{\"id\":9,\"method\":\"resources/list\"}");
  expect(said.status == 200);
  expect(said.body == "{\"jsonrpc\":\"2.0\",\"id\":9,\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}");
});

test("a body that is not a request at all is refused with -32600", () => {
  let said = answering("{\"id\":4}");
  expect(said.status == 200);
  expect(said.body.indexOf("\"id\":4,\"error\":{\"code\":-32600") >= 0);
});

test("tools/list hands each inputSchema over as an object, not a quoted string", () => {
  let said = answering("{\"id\":5,\"method\":\"tools/list\"}");
  expect(said.status == 200);
  expect(said.body.startsWith("{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"tools\":["));
  expect(said.body.endsWith("]}}"));
  expect(said.body.indexOf("\"inputSchema\":{") >= 0);
  expect(said.body.indexOf("\"inputSchema\":\"") < 0);
  expect(said.body.indexOf("\\\"type\\\"") < 0);
  expect(said.body.indexOf("\\\"properties\\\"") < 0);
});

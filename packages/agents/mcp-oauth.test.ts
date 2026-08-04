// The parts of the OAuth flow that can be checked without a server.
//
// Discovery, registration and the token calls all need one, and are covered by
// e2e/oauth-double.mjs — a real authorization server small enough to run in the
// test suite. What is here is everything a wrong answer would make silently
// wrong: the challenge, the encoding, and the URL splitting that decides which
// well-known address gets asked.
//
//   cd packages/agents && lumen test mcp-oauth.test.ts

import { base64Url, challengeFor, consentUrl, formEncode, newState, newVerifier, originOf, pathOf, urlEncode } from "./mcp-oauth.ts";
import { jsonOf } from "./mcp.ts";

// --- PKCE -----------------------------------------------------------------------

test("the challenge matches the RFC's own worked example", () => {
  // RFC 7636 appendix B. Worth pinning rather than trusting: every step of it
  // — hex to bytes, base64, the URL alphabet, dropping the padding — produces
  // a plausible-looking string when done wrong, and the only symptom is that
  // every connector refuses the exchange at the very last call.
  expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
         == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a verifier is long enough and in the right alphabet", () => {
  let v = newVerifier();
  // The RFC's floor is 43 characters and its ceiling 128.
  expect(v.length >= 43);
  expect(v.length <= 128);
  expect(v.indexOf("+") < 0);
  expect(v.indexOf("/") < 0);
  expect(v.indexOf("=") < 0);
});

test("two verifiers are not the same verifier", () => {
  expect(newVerifier() != newVerifier());
  expect(newState() != newState());
});

test("base64url rewrites the alphabet and drops the padding", () => {
  expect(base64Url("ab+/cd==") == "ab-_cd");
});

// --- encoding ---------------------------------------------------------------------

test("a redirect URI survives encoding byte for byte", () => {
  // An authorization server compares this against what was registered, with no
  // normalising. A ":" or "/" left raw is a mismatch and a dead flow.
  expect(urlEncode("https://joule.sh/api/connect/callback")
         == "https%3A%2F%2Fjoule.sh%2Fapi%2Fconnect%2Fcallback");
});

test("the unreserved set is left alone", () => {
  expect(urlEncode("aZ09-._~") == "aZ09-._~");
});

test("a space becomes %20, not a plus", () => {
  // Scopes are space-separated, so this is the difference between asking for
  // two scopes and asking for one oddly-named one.
  expect(urlEncode("read write") == "read%20write");
});

test("an empty field is left out rather than sent empty", () => {
  // A server that is sent `scope=` may read it as "no scopes" and issue a
  // token that can do nothing, which then fails on the first tool call rather
  // than here.
  let fields = new Map<string, string>();
  fields.set("client_id", "abc");
  fields.set("scope", "");
  fields.set("state", "xyz");
  expect(formEncode(fields) == "client_id=abc&state=xyz");
});

// --- where the well-known documents live -------------------------------------------

test("an origin is read without its path", () => {
  expect(originOf("https://mcp.linear.app/mcp") == "https://mcp.linear.app");
  expect(originOf("http://127.0.0.1:8931/mcp") == "http://127.0.0.1:8931");
});

test("something that is not an http address has no origin", () => {
  expect(originOf("mcp-fs") == "");
  expect(originOf("file:///etc/passwd") == "");
});

test("a bare origin has an empty path, not a slash", () => {
  // RFC 9728 inserts the well-known segment BEFORE the path, so a stray "/"
  // asks for ".../oauth-protected-resource/" and gets a 404 from a server that
  // publishes the document perfectly well.
  expect(pathOf("https://mcp.linear.app") == "");
  expect(pathOf("https://mcp.linear.app/") == "");
  expect(pathOf("https://mcp.linear.app/mcp") == "/mcp");
  expect(pathOf("https://mcp.atlassian.com/v1/mcp") == "/v1/mcp");
});

test("a query is not part of the path", () => {
  expect(pathOf("https://example.test/mcp?tenant=a") == "/mcp");
});

// --- the consent URL ------------------------------------------------------------------

test("the consent URL carries what the server needs to hold us to PKCE", () => {
  let url = consentUrl({
    authorizeUrl: "https://mcp.linear.app/authorize",
    clientId: "client-1",
    redirectUri: "https://joule.sh/api/connect/callback",
    state: "st-1",
    verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    scope: "read write",
    resource: "https://mcp.linear.app/mcp",
  });
  expect(url.startsWith("https://mcp.linear.app/authorize?"));
  expect(url.indexOf("response_type=code") >= 0);
  expect(url.indexOf("client_id=client-1") >= 0);
  expect(url.indexOf("code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") >= 0);
  expect(url.indexOf("code_challenge_method=S256") >= 0);
  expect(url.indexOf("state=st-1") >= 0);
  expect(url.indexOf("scope=read%20write") >= 0);
  // The verifier is the secret half. Sending it here would hand it to the
  // browser, and with it every protection PKCE offers.
  expect(url.indexOf("dBjftJeZ4CVP") < 0);
});

test("an authorize endpoint that already has a query keeps it", () => {
  let url = consentUrl({
    authorizeUrl: "https://example.test/authorize?tenant=acme",
    clientId: "c", redirectUri: "https://joule.sh/api/connect/callback",
    state: "s", verifier: "v", scope: "", resource: "",
  });
  expect(url.indexOf("?tenant=acme&") >= 0);
  // And asks for nothing it was not given.
  expect(url.indexOf("scope=") < 0);
  expect(url.indexOf("resource=") < 0);
});

// --- the transport a hosted connector actually speaks ------------------------

test("an SSE-framed reply is unwrapped to its envelope", () => {
  // What Linear answers once the Accept header is right: the JSON-RPC envelope
  // as one Server-Sent Event rather than as the body.
  let framed = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
  expect(jsonOf(framed) == "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}");
});

test("a plain JSON body is left exactly as it is", () => {
  expect(jsonOf("{\"jsonrpc\":\"2.0\",\"id\":1}") == "{\"jsonrpc\":\"2.0\",\"id\":1}");
  expect(jsonOf("  {\"a\":1}  ") == "{\"a\":1}");
});

test("the reply wins over the notifications before it", () => {
  // A stream may carry progress before the answer. The last envelope is the
  // one the caller asked for; taking the first would report progress as the
  // result and find no tools in it.
  let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n"
    + "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"list_issues\"}]}}\n\n";
  expect(jsonOf(stream).indexOf("list_issues") > 0);
  expect(jsonOf(stream).indexOf("progress") < 0);
});

test("something that is neither is handed back rather than swallowed", () => {
  // An HTML error page from a proxy in the middle: the caller reports it,
  // which beats reporting an empty envelope it cannot explain.
  expect(jsonOf("<html>bad gateway</html>") == "<html>bad gateway</html>");
});

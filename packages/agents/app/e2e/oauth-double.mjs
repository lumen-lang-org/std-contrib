// A stand-in connector that signs you in, so the whole OAuth flow can be
// tested without a vendor.
//
// The flow this exercises has six round trips and every one of them can fail
// in a way that looks like one of the others: discovery finds no document,
// registration is refused, the challenge does not match the verifier, the
// redirect is compared byte-for-byte and differs, the code is replayed, the
// refresh token is dead. Against a real connector none of that is reachable
// from a test — it needs a person at a consent screen and an account.
//
// So this is that connector: the four documents, the three endpoints, and an
// MCP server behind them that refuses anything without the token it issued.
// It is deliberately strict. A double that accepts a wrong verifier would let
// the one bug PKCE exists to prevent through every run.
//
//   node e2e/oauth-double.mjs        # :8936, or OAUTH_DOUBLE_PORT
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.OAUTH_DOUBLE_PORT ?? 8936);
const BASE = `http://127.0.0.1:${PORT}`;

// Everything this remembers, and it is all per-process: a run gets a clean
// server, and nothing here outlives it.
const clients = new Map();   // client_id -> { redirectUris }
const codes = new Map();     // code -> { clientId, challenge, redirectUri, used }
const tokens = new Map();    // access token -> { clientId, dead }
const refresh = new Map();   // refresh token -> { clientId, dead }

// Whether the caller ever completed a real exchange, so a test can assert the
// difference between "connected" and "the double let anything through".
let issued = 0;

const TOOLS = [
  { name: "list_issues", description: "List issues in the workspace.",
    inputSchema: { type: "object", properties: {} } },
  { name: "create_issue", description: "File a new issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// base64url of a SHA-256, which is what `code_challenge_method: S256` means.
const s256 = (verifier) =>
  createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const form = (body) => Object.fromEntries(new URLSearchParams(body));

const read = (req) => new Promise((done) => {
  let text = "";
  req.on("data", (c) => { text += c; });
  req.on("end", () => done(text));
});

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const path = url.pathname;

  // --- RFC 9728: which authorization server guards /mcp ---------------------
  if (path === "/.well-known/oauth-protected-resource/mcp") {
    return json(res, 200, {
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ["read", "write"],
      bearer_methods_supported: ["header"],
    });
  }

  // --- RFC 8414: where its endpoints are ------------------------------------
  if (path === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      scopes_supported: ["read", "write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      // S256 only, like Linear. A double that also offered `plain` would let a
      // client that never learned to hash pass every test here and fail
      // against the connector people actually use.
      code_challenge_methods_supported: ["S256"],
    });
  }

  // --- RFC 7591: register a client, with no credentials ---------------------
  if (path === "/register" && req.method === "POST") {
    const asked = JSON.parse((await read(req)) || "{}");
    const redirectUris = asked.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return json(res, 400, { error: "invalid_redirect_uri" });
    }
    const clientId = "dbl-" + randomBytes(6).toString("hex");
    clients.set(clientId, { redirectUris });
    // A public client: no secret, which is the case PKCE is designed for and
    // the one every hosted connector on the shelf actually returns.
    return json(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    });
  }

  // --- the consent screen ---------------------------------------------------
  //
  // Auto-approved. There is no person in a test run, and what is under test is
  // everything either side of the approval rather than the approval itself.
  // `?deny=1` is how a test reaches the refusal path.
  if (path === "/authorize") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = clients.get(clientId);
    if (client === undefined) {
      return json(res, 400, { error: "invalid_client" });
    }
    // Byte-for-byte, as a real one does. This is the check that catches a
    // deployment whose public address moved without re-registering.
    if (!client.redirectUris.includes(redirectUri)) {
      return json(res, 400, { error: "invalid_redirect_uri" });
    }
    const back = new URL(redirectUri);
    back.searchParams.set("state", q.get("state") ?? "");
    if (q.get("deny") === "1") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "the person said no");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (q.get("code_challenge_method") !== "S256" || (q.get("code_challenge") ?? "") === "") {
      return json(res, 400, { error: "invalid_request", error_description: "S256 challenge required" });
    }
    const code = "code-" + randomBytes(8).toString("hex");
    codes.set(code, {
      clientId, redirectUri, challenge: q.get("code_challenge"), used: false,
    });
    back.searchParams.set("code", code);
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  // --- the token endpoint ----------------------------------------------------
  if (path === "/token" && req.method === "POST") {
    const body = form(await read(req));

    if (body.grant_type === "refresh_token") {
      const held = refresh.get(body.refresh_token ?? "");
      if (held === undefined || held.dead) {
        return json(res, 400, { error: "invalid_grant", error_description: "that refresh token is spent" });
      }
      // Rotation, which is the norm now and the case a client gets wrong: the
      // old token dies here, so a client that keeps it is logged out on its
      // next renewal with nothing to say why.
      held.dead = true;
      return json(res, 200, grant(held.clientId));
    }

    if (body.grant_type !== "authorization_code") {
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    const held = codes.get(body.code ?? "");
    if (held === undefined || held.used) {
      return json(res, 400, { error: "invalid_grant", error_description: "that code is spent" });
    }
    held.used = true;
    if (body.redirect_uri !== held.redirectUri) {
      return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri does not match" });
    }
    if ((body.code_verifier ?? "") === "" || s256(body.code_verifier) !== held.challenge) {
      return json(res, 400, { error: "invalid_grant", error_description: "code_verifier does not match the challenge" });
    }
    return json(res, 200, grant(held.clientId));
  }

  // --- the MCP server itself --------------------------------------------------
  if (path === "/mcp") {
    const said = req.headers.authorization ?? "";
    const token = said.startsWith("Bearer ") ? said.slice(7) : "";
    const held = tokens.get(token);
    if (held === undefined || held.dead) {
      // Exactly what the real ones answer, header included — it is how a
      // client is supposed to find the authorization server in the first
      // place, and a double that answered a bare 401 would let a client that
      // never reads it pass.
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="OAuth", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const rpc = JSON.parse((await read(req)) || "{}");
    if (rpc.method === "initialize") {
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "oauth-double", version: "1" } } });
    }
    if (rpc.method === "tools/list") {
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: TOOLS } });
    }
    return json(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result: {} });
  }

  // What a test asks to find out whether a real exchange happened, rather than
  // inferring it from a screen that might say "connected" for another reason.
  if (path === "/issued") { return json(res, 200, { issued }); }

  res.writeHead(404).end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`oauth double on ${BASE}`);
});

function grant(clientId) {
  const access = "at-" + randomBytes(12).toString("hex");
  const renew = "rt-" + randomBytes(12).toString("hex");
  tokens.set(access, { clientId, dead: false });
  refresh.set(renew, { clientId, dead: false });
  issued = issued + 1;
  return {
    access_token: access,
    refresh_token: renew,
    token_type: "Bearer",
    // Short on purpose, so a test can watch a token go stale without waiting
    // an hour for it.
    expires_in: 120,
    scope: "read write",
  };
}

// Connecting to an MCP server that wants OAuth, without anyone registering an
// app first.
//
// Every hosted connector worth having — Linear, Atlassian, Notion, Sentry —
// answers an unauthenticated call with `401` and
// `WWW-Authenticate: Bearer realm="OAuth"`. None of them accepts a pasted API
// key. So the shelf's `bearer` kind, which is the only thing this package could
// express before this file, could not reach a single one of them: the Sentry
// entry shipped as `authKind: "bearer"` and had never worked.
//
// What makes the flow worth building rather than dreading is that all four also
// publish a `registration_endpoint`. The client is created at connect time, by
// us, over HTTP — there is no console to visit, no client secret to paste, no
// per-deployment app to keep alive. A person presses Connect and approves a
// consent screen, and that is the whole of it. That property is why this file
// refuses to fall back to a hand-registered client: the moment one connector
// needs paperwork, every connector's story becomes "it depends".
//
// Four documents, in the order this reads them:
//
//   RFC 9728  which authorization server guards this resource
//   RFC 8414  where that server's authorize/token/register endpoints are
//   RFC 7591  registering a client dynamically, with no credentials
//   RFC 7636  PKCE, which is what makes a public client safe to be
//
// Nothing here touches the database or the credential store. It takes URLs and
// returns records, so it is testable without a server and cannot leak a token
// into a row by accident — `api.ts` owns where anything is written.

import { jsonText, jsonRaw, jsonList } from "./scan.ts";

// --- small string work the standard library does not do ------------------------

function hexValue(ch: string): int {
  if (ch >= "0" && ch <= "9") { return ch.charCodeAt(0) - 48; }
  if (ch >= "a" && ch <= "f") { return ch.charCodeAt(0) - 87; }
  if (ch >= "A" && ch <= "F") { return ch.charCodeAt(0) - 55; }
  return -1;
}

// The bytes a hex string stands for.
//
// `crypto.sha256` returns 64 hex characters, and base64 of that text is the
// base64 of a 64-character string rather than of the 32 bytes it denotes — a
// challenge computed that way is the right length and always wrong. The same
// trap `websocket/handshake.ts` documents for its key.
function bytesFromHex(hex: string): string {
  let out = "";
  let i: int = 0;
  while (i + 1 < hex.length) {
    let hi = hexValue(hex.charAt(i));
    let lo = hexValue(hex.charAt(i + 1));
    if (hi < 0 || lo < 0) { return out; }
    out = out + String.fromCharCode(hi * 16 + lo);
    i = i + 2;
  }
  return out;
}

// base64 in the URL-safe alphabet, unpadded — what every OAuth document means
// when it says "base64url".
export function base64Url(b64: string): string {
  let out = "";
  let i: int = 0;
  while (i < b64.length) {
    let c = b64.charAt(i);
    if (c == "+") { out = out + "-"; }
    else if (c == "/") { out = out + "_"; }
    else if (c != "=") { out = out + c; }
    i = i + 1;
  }
  return out;
}

function unreserved(ch: string): bool {
  if (ch >= "a" && ch <= "z") { return true; }
  if (ch >= "A" && ch <= "Z") { return true; }
  if (ch >= "0" && ch <= "9") { return true; }
  return ch == "-" || ch == "." || ch == "_" || ch == "~";
}

const HEX = "0123456789ABCDEF";

// Percent-encoding, for query strings and form bodies alike.
//
// Written out because a wrong one here is not a formatting problem: a scope
// string joined with an unencoded space silently truncates the request, and a
// redirect URI whose `:` and `/` survive unencoded is compared byte-for-byte
// by the authorization server and rejected as a mismatch.
export function urlEncode(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (unreserved(ch)) {
      out = out + ch;
    } else {
      let code = text.charCodeAt(i);
      // Above the ASCII range a character stands for more than one byte, and
      // this encodes the code unit rather than UTF-8. Nothing this file sends
      // is outside ASCII — client names, scopes, URLs and opaque tokens — and
      // encoding it wrongly beats encoding it not at all.
      out = out + "%" + HEX.charAt((code / 16) % 16) + HEX.charAt(code % 16);
    }
    i = i + 1;
  }
  return out;
}

// A form body or query string from pairs, in the order given.
export function formEncode(fields: Map<string, string>): string {
  let out = "";
  for (const name of fields.keys()) {
    let value = fields.get(name) ?? "";
    if (value == "") { continue; }
    if (out != "") { out = out + "&"; }
    out = out + urlEncode(name) + "=" + urlEncode(value);
  }
  return out;
}

// The scheme-and-authority half of a URL, or "" when it cannot be read.
export function originOf(url: string): string {
  let text = url.trim();
  let mark = text.indexOf("://");
  if (mark < 0) { return ""; }
  let scheme = text.slice(0, mark).toLowerCase();
  if (scheme != "http" && scheme != "https") { return ""; }
  let rest = text.slice(mark + 3, text.length);
  let cut = rest.length;
  let slash = rest.indexOf("/");
  if (slash >= 0 && slash < cut) { cut = slash; }
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) { cut = question; }
  let authority = rest.slice(0, cut);
  if (authority == "") { return ""; }
  return scheme + "://" + authority;
}

// The path half, without a query or fragment. "" when the URL is just an
// origin — NOT "/", because RFC 9728 builds its well-known URL by inserting a
// segment before the path, and a spurious "/" makes that a different address.
export function pathOf(url: string): string {
  let origin = originOf(url);
  if (origin == "") { return ""; }
  let rest = url.trim().slice(origin.length, url.trim().length);
  let cut = rest.length;
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) { cut = question; }
  let fragment = rest.indexOf("#");
  if (fragment >= 0 && fragment < cut) { cut = fragment; }
  let path = rest.slice(0, cut);
  if (path == "/") { return ""; }
  return path;
}

// --- PKCE ------------------------------------------------------------------------

// A fresh code verifier: 32 random bytes, base64url — 43 characters, which is
// the RFC's minimum and its recommendation at once.
export function newVerifier(): string {
  return base64Url(crypto.base64Encode(bytesFromHex(crypto.randomBytes(32))));
}

// The S256 challenge for a verifier.
//
// Only S256. `plain` is in the RFC and three of the four servers offer it, and
// it makes the challenge equal to the secret it is supposed to protect — which
// is worth nothing over a redirect a browser can be made to follow. Linear
// declines to offer `plain` at all, which settles it.
export function challengeFor(verifier: string): string {
  return base64Url(crypto.base64Encode(bytesFromHex(crypto.sha256(verifier))));
}

// Opaque, unguessable, and long enough to carry a lookup key.
export function newState(): string {
  return crypto.randomBytes(16);
}

// --- discovery ---------------------------------------------------------------------

// Where a connector's authorization server lives and what it can do.
export type Discovery = {
  issuer: string,
  authorizeUrl: string,
  tokenUrl: string,
  // "" when the server does not register clients dynamically. That is a dead
  // end for this package rather than a degraded mode, and the caller says so.
  registerUrl: string,
  // Space-separated, as they go on the wire. What the SERVER offers; the
  // caller decides what to ask for.
  scopesSupported: string,
  // Empty when everything above was read. Otherwise a sentence for a person.
  problem: string,
};

function noDiscovery(why: string): Discovery {
  return { issuer: "", authorizeUrl: "", tokenUrl: "", registerUrl: "",
           scopesSupported: "", problem: why };
}

// A GET that returns the body only when the server answered 200 with one.
function fetchJson(url: string): string {
  let headers = new Map<string, string>();
  headers.set("accept", "application/json");
  let res = http.request(url, "GET", "", headers);
  if (!res.ok) { return ""; }
  if (res.status != 200) { return ""; }
  // A 200 that is an HTML error page parses as nothing and would otherwise be
  // reported as a metadata document with every field missing.
  let body = res.body.trim();
  if (!body.startsWith("{")) { return ""; }
  return body;
}

// Which authorization server guards this MCP endpoint (RFC 9728).
//
// The `WWW-Authenticate` header on the 401 is the other way to learn this, and
// is not used: `http.request` here surfaces a status and a body and not the
// response headers, and the well-known address is derivable without it. Where
// a server publishes no such document — Atlassian does not — the resource's own
// origin is assumed to be its own authorization server, which is what every
// one of these deployments actually does.
export function resourceIssuer(endpoint: string): string {
  let origin = originOf(endpoint);
  if (origin == "") { return ""; }
  let document = fetchJson(origin + "/.well-known/oauth-protected-resource" + pathOf(endpoint));
  if (document == "") {
    document = fetchJson(origin + "/.well-known/oauth-protected-resource");
  }
  if (document == "") { return origin; }
  let servers = jsonList(jsonRaw(document, "authorization_servers"));
  if (servers.length == 0) { return origin; }
  // A JSON string element arrives quoted; take the text between the quotes.
  let first = servers[0].trim();
  if (first.startsWith("\"") && first.length > 1) {
    first = first.slice(1, first.length - 1);
  }
  if (first == "") { return origin; }
  return first;
}

// The authorization server's own metadata (RFC 8414), trying the four
// addresses in the order the specification prefers them.
//
// The path-inserted forms come first and matter: an issuer with a path — which
// is what a multi-tenant deployment hands out — puts its document at
// `/.well-known/oauth-authorization-server/tenant`, and the naive
// `issuer + "/.well-known/..."` finds nothing there.
export function discover(endpoint: string): Discovery {
  let issuer = resourceIssuer(endpoint);
  if (issuer == "") { return noDiscovery("\"" + endpoint + "\" is not an http(s) address"); }

  let origin = originOf(issuer);
  let path = pathOf(issuer);
  let tried: string[] = [];
  tried.push(origin + "/.well-known/oauth-authorization-server" + path);
  tried.push(origin + "/.well-known/openid-configuration" + path);
  if (path != "") {
    tried.push(issuer + "/.well-known/oauth-authorization-server");
    tried.push(issuer + "/.well-known/openid-configuration");
  }

  let i: int = 0;
  while (i < tried.length) {
    let document = fetchJson(tried[i]);
    if (document != "") {
      let authorize = jsonText(document, "authorization_endpoint");
      let token = jsonText(document, "token_endpoint");
      if (authorize != "" && token != "") {
        let scopes = "";
        let offered = jsonList(jsonRaw(document, "scopes_supported"));
        let s: int = 0;
        while (s < offered.length) {
          let one = offered[s].trim();
          if (one.startsWith("\"") && one.length > 1) { one = one.slice(1, one.length - 1); }
          if (one != "") { scopes = scopes == "" ? one : scopes + " " + one; }
          s = s + 1;
        }
        let found: Discovery = {
          issuer: jsonText(document, "issuer") == "" ? issuer : jsonText(document, "issuer"),
          authorizeUrl: authorize,
          tokenUrl: token,
          registerUrl: jsonText(document, "registration_endpoint"),
          scopesSupported: scopes,
          problem: "",
        };
        return found;
      }
    }
    i = i + 1;
  }
  return noDiscovery(issuer + " publishes no OAuth metadata, so this cannot find where to send you");
}

// --- registration ------------------------------------------------------------------

// A client this deployment created for itself.
export type RegisteredClient = {
  clientId: string,
  // "" for a public client, which is the common answer and the one PKCE is
  // designed for. Stored encrypted when a server does issue one.
  clientSecret: string,
  problem: string,
};

// Register with the authorization server (RFC 7591).
//
// `token_endpoint_auth_method: "none"` asks to be a public client on purpose.
// This package runs on a server and could keep a secret, but the secret would
// be per-deployment and per-connector, and every one of them would have to be
// kept, rotated and restored — for a flow PKCE already protects. Servers that
// insist on issuing one are handled anyway, because saying so costs a field.
export function registerClient(registerUrl: string, redirectUri: string, clientName: string): RegisteredClient {
  if (registerUrl == "") {
    return { clientId: "", clientSecret: "",
             problem: "this connector does not register clients automatically, so it needs an app created by hand" };
  }
  let body = "{\"client_name\":" + JSON.stringify(clientName)
    + ",\"redirect_uris\":[" + JSON.stringify(redirectUri) + "]"
    + ",\"grant_types\":[\"authorization_code\",\"refresh_token\"]"
    + ",\"response_types\":[\"code\"]"
    + ",\"token_endpoint_auth_method\":\"none\"}";
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  let res = http.request(registerUrl, "POST", body, headers);
  if (!res.ok) {
    return { clientId: "", clientSecret: "", problem: "no answer from " + registerUrl };
  }
  // 201 is what the RFC says; several of these answer 200. Both are a
  // registration, and refusing one of them would be refusing half the shelf.
  if (res.status != 200 && res.status != 201) {
    return { clientId: "", clientSecret: "",
             problem: registerUrl + " refused to register this client: HTTP " + `${res.status}` };
  }
  let id = jsonText(res.body, "client_id");
  if (id == "") {
    return { clientId: "", clientSecret: "", problem: registerUrl + " answered without a client_id" };
  }
  return { clientId: id, clientSecret: jsonText(res.body, "client_secret"), problem: "" };
}

// --- the authorization request -------------------------------------------------------

// Everything the consent URL needs. A record rather than seven positional
// arguments, because six of them are opaque strings and a swapped pair would
// produce a URL that looks right and fails at the far end.
export type Consent = {
  authorizeUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
  verifier: string,
  // What to ask for. "" sends no `scope` at all, which is what a server with
  // no declared scopes wants.
  scope: string,
  // The MCP endpoint itself (RFC 8707). Linear and Notion bind their tokens to
  // it; sending it costs nothing where it is ignored.
  resource: string,
};

export function consentUrl(ask: Consent): string {
  let fields = new Map<string, string>();
  fields.set("response_type", "code");
  fields.set("client_id", ask.clientId);
  fields.set("redirect_uri", ask.redirectUri);
  fields.set("state", ask.state);
  fields.set("code_challenge", challengeFor(ask.verifier));
  fields.set("code_challenge_method", "S256");
  fields.set("scope", ask.scope);
  fields.set("resource", ask.resource);
  // An authorize endpoint is allowed to carry its own query already.
  let joiner = ask.authorizeUrl.indexOf("?") >= 0 ? "&" : "?";
  return ask.authorizeUrl + joiner + formEncode(fields);
}

// --- tokens ------------------------------------------------------------------------

// What an authorization server hands back, and how long it is good for.
export type Grant = {
  accessToken: string,
  // "" when the server issues none. The connector then works until the access
  // token expires and needs a person to press Connect again, which is why the
  // console draws "Reconnect" rather than pretending it is still fine.
  refreshToken: string,
  // Seconds. 0 when the server did not say, which this treats as "no expiry
  // known" rather than "already expired".
  expiresIn: int,
  problem: string,
};

function noGrant(why: string): Grant {
  return { accessToken: "", refreshToken: "", expiresIn: 0, problem: why };
}

// POST a form to the token endpoint and read what comes back.
function tokenCall(tokenUrl: string, fields: Map<string, string>): Grant {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("accept", "application/json");
  let res = http.request(tokenUrl, "POST", formEncode(fields), headers);
  if (!res.ok) { return noGrant("no answer from " + tokenUrl); }
  if (res.status != 200) {
    // The RFC gives errors a shape, and it is worth reading: "invalid_grant"
    // on a refresh means the person revoked us, which is a different thing to
    // tell them than "the server is down".
    let code = jsonText(res.body, "error");
    let said = jsonText(res.body, "error_description");
    if (said != "") { return noGrant(said); }
    if (code != "") { return noGrant(tokenUrl + " refused the exchange: " + code); }
    return noGrant(tokenUrl + " refused the exchange: HTTP " + `${res.status}`);
  }
  let access = jsonText(res.body, "access_token");
  if (access == "") { return noGrant(tokenUrl + " answered without an access_token"); }
  // 0 where the server said nothing, which the caller reads as "no expiry
  // known" rather than "already expired" — the difference between a connector
  // that works and one that reconnects on every call.
  let seconds: int = parseInt(jsonRaw(res.body, "expires_in").trim()) ?? 0;
  return { accessToken: access, refreshToken: jsonText(res.body, "refresh_token"),
           expiresIn: seconds, problem: "" };
}

// What the callback needs to turn a code into a token.
export type Exchange = {
  tokenUrl: string,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  verifier: string,
  resource: string,
};

export function exchangeCode(ask: Exchange): Grant {
  let fields = new Map<string, string>();
  fields.set("grant_type", "authorization_code");
  fields.set("code", ask.code);
  fields.set("redirect_uri", ask.redirectUri);
  fields.set("client_id", ask.clientId);
  fields.set("client_secret", ask.clientSecret);
  fields.set("code_verifier", ask.verifier);
  fields.set("resource", ask.resource);
  return tokenCall(ask.tokenUrl, fields);
}

// A new access token from a refresh token.
//
// The reply may or may not carry a NEW refresh token. Where it does, the old
// one is usually dead on arrival — rotation is the norm now — so a caller that
// keeps the old one is one refresh away from being logged out with no way to
// say why. `refreshed.refreshToken == ""` means "keep what you have".
export function refreshGrant(tokenUrl: string, refreshToken: string,
                             clientId: string, clientSecret: string, resource: string): Grant {
  let fields = new Map<string, string>();
  fields.set("grant_type", "refresh_token");
  fields.set("refresh_token", refreshToken);
  fields.set("client_id", clientId);
  fields.set("client_secret", clientSecret);
  fields.set("resource", resource);
  return tokenCall(tokenUrl, fields);
}

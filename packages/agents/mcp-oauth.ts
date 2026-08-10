import { jsonText, jsonRaw, jsonList } from "./scan.ts";

function hexValue(ch: string): int {
  if (ch >= "0" && ch <= "9") {
    return ch.charCodeAt(0) - 48;
  }
  if (ch >= "a" && ch <= "f") {
    return ch.charCodeAt(0) - 87;
  }
  if (ch >= "A" && ch <= "F") {
    return ch.charCodeAt(0) - 55;
  }
  return -1;
}

function bytesFromHex(hex: string): string {
  let out = "";
  let i: int = 0;
  while (i + 1 < hex.length) {
    let hi = hexValue(hex.charAt(i));
    let lo = hexValue(hex.charAt(i + 1));
    if (hi < 0 || lo < 0) {
      return out;
    }
    out = out + String.fromCharCode(hi * 16 + lo);
    i = i + 2;
  }
  return out;
}

export function base64Url(b64: string): string {
  let out = "";
  let i: int = 0;
  while (i < b64.length) {
    let c = b64.charAt(i);
    if (c == "+") {
      out = out + "-";
    }
    else if (c == "/") {
      out = out + "_";
    }
    else if (c != "=") {
      out = out + c;
    }
    i = i + 1;
  }
  return out;
}

function unreserved(ch: string): bool {
  if (ch >= "a" && ch <= "z") {
    return true;
  }
  if (ch >= "A" && ch <= "Z") {
    return true;
  }
  if (ch >= "0" && ch <= "9") {
    return true;
  }
  return ch == "-" || ch == "." || ch == "_" || ch == "~";
}

const HEX = "0123456789ABCDEF";

export function urlEncode(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (unreserved(ch)) {
      out = out + ch;
    } else {
      let code = text.charCodeAt(i);
      out = out + "%" + HEX.charAt((code / 16) % 16) + HEX.charAt(code % 16);
    }
    i = i + 1;
  }
  return out;
}

export function formEncode(fields: Map<string, string>): string {
  let out = "";
  for (const name of fields.keys()) {
    let value = fields.get(name) ?? "";
    if (value == "") {
      continue;
    }
    if (out != "") {
      out = out + "&";
    }
    out = out + urlEncode(name) + "=" + urlEncode(value);
  }
  return out;
}

export function originOf(url: string): string {
  let text = url.trim();
  let mark = text.indexOf("://");
  if (mark < 0) {
    return "";
  }
  let scheme = text.slice(0, mark).toLowerCase();
  if (scheme != "http" && scheme != "https") {
    return "";
  }
  let rest = text.slice(mark + 3, text.length);
  let cut = rest.length;
  let slash = rest.indexOf("/");
  if (slash >= 0 && slash < cut) {
    cut = slash;
  }
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) {
    cut = question;
  }
  let authority = rest.slice(0, cut);
  if (authority == "") {
    return "";
  }
  return scheme + "://" + authority;
}

export function pathOf(url: string): string {
  let origin = originOf(url);
  if (origin == "") {
    return "";
  }
  let rest = url.trim().slice(origin.length, url.trim().length);
  let cut = rest.length;
  let question = rest.indexOf("?");
  if (question >= 0 && question < cut) {
    cut = question;
  }
  let fragment = rest.indexOf("#");
  if (fragment >= 0 && fragment < cut) {
    cut = fragment;
  }
  let path = rest.slice(0, cut);
  if (path == "/") {
    return "";
  }
  return path;
}

export function newVerifier(): string {
  return base64Url(crypto.base64Encode(bytesFromHex(crypto.randomBytes(32))));
}

export function challengeFor(verifier: string): string {
  return base64Url(crypto.base64Encode(bytesFromHex(crypto.sha256(verifier))));
}

export function newState(): string {
  return crypto.randomBytes(16);
}

export type Discovery = {
  issuer: string,
  authorizeUrl: string,
  tokenUrl: string,
  registerUrl: string,
  scopesSupported: string,
  problem: string,
};

function noDiscovery(why: string): Discovery {
  return { issuer: "", authorizeUrl: "", tokenUrl: "", registerUrl: "",
           scopesSupported: "", problem: why };
}

function fetchJson(url: string): string {
  let headers = new Map<string, string>();
  headers.set("accept", "application/json");
  let res = http.request(url, "GET", "", headers);
  if (!res.ok) {
    return "";
  }
  if (res.status != 200) {
    return "";
  }
  let body = res.body.trim();
  if (!body.startsWith("{")) {
    return "";
  }
  return body;
}

export function resourceIssuer(endpoint: string): string {
  let origin = originOf(endpoint);
  if (origin == "") {
    return "";
  }
  let document = fetchJson(origin + "/.well-known/oauth-protected-resource" + pathOf(endpoint));
  if (document == "") {
    document = fetchJson(origin + "/.well-known/oauth-protected-resource");
  }
  if (document == "") {
    return origin;
  }
  let servers = jsonList(jsonRaw(document, "authorization_servers"));
  if (servers.length == 0) {
    return origin;
  }
  let first = servers[0].trim();
  if (first.startsWith("\"") && first.length > 1) {
    first = first.slice(1, first.length - 1);
  }
  if (first == "") {
    return origin;
  }
  return first;
}

export function discover(endpoint: string): Discovery {
  let issuer = resourceIssuer(endpoint);
  if (issuer == "") {
    return noDiscovery("\"" + endpoint + "\" is not an http(s) address");
  }

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
          if (one.startsWith("\"") && one.length > 1) {
            one = one.slice(1, one.length - 1);
          }
          if (one != "") {
            scopes = scopes == "" ? one : scopes + " " + one;
          }
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

export type RegisteredClient = {
  clientId: string,
  clientSecret: string,
  problem: string,
};

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
  if (res.status != 200 && res.status != 201) {
    return { clientId: "", clientSecret: "",
             problem: registerUrl + " refused to register this client: HTTP " + `${res.status}` };
  }
  let id = jsonText(res.body, "client_id");
  if (id == "") {
    return {
      clientId: "",
      clientSecret: "",
      problem: registerUrl + " answered without a client_id",
    };
  }
  return { clientId: id, clientSecret: jsonText(res.body, "client_secret"), problem: "" };
}

export type Consent = {
  authorizeUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
  verifier: string,
  scope: string,
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
  let joiner = ask.authorizeUrl.indexOf("?") >= 0 ? "&" : "?";
  return ask.authorizeUrl + joiner + formEncode(fields);
}

export type Grant = {
  accessToken: string,
  refreshToken: string,
  expiresIn: int,
  problem: string,
};

function noGrant(why: string): Grant {
  return { accessToken: "", refreshToken: "", expiresIn: 0, problem: why };
}

function tokenCall(tokenUrl: string, fields: Map<string, string>): Grant {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("accept", "application/json");
  let res = http.request(tokenUrl, "POST", formEncode(fields), headers);
  if (!res.ok) {
    return noGrant("no answer from " + tokenUrl);
  }
  if (res.status != 200) {
    let code = jsonText(res.body, "error");
    let said = jsonText(res.body, "error_description");
    if (said != "") {
      return noGrant(said);
    }
    if (code != "") {
      return noGrant(tokenUrl + " refused the exchange: " + code);
    }
    return noGrant(tokenUrl + " refused the exchange: HTTP " + `${res.status}`);
  }
  let access = jsonText(res.body, "access_token");
  if (access == "") {
    return noGrant(tokenUrl + " answered without an access_token");
  }
  let seconds: int = parseInt(jsonRaw(res.body, "expires_in").trim()) ?? 0;
  return { accessToken: access, refreshToken: jsonText(res.body, "refresh_token"),
           expiresIn: seconds, problem: "" };
}

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

// Google service-account auth, for Vertex AI.
//
//   let bearer = vertexBearer(saJson, Date.now());
//   if (!bearer.ok) { /* bearer.error is a sentence */ }
//   headers.set("authorization", "Bearer " + bearer.token);
//
// Vertex is the one provider whose credential is not the thing sent on the
// wire: the stored secret is a service-account JSON, and what the request
// carries is an OAuth2 access token minted from it — signed JWT in, token
// out, dead within the hour. So the credential store keeps the JSON (it never
// expires and rotation is an operator action), and this file turns it into
// tokens on demand, caching each one until just before its expiry.
//
// The signing is RS256 through the openssl binary, file-based — the same
// shell-out idiom the package already uses for docker and base64. No SDK: the
// whole exchange is one signature and one POST, and a dependency for that is
// a supply chain for two curl-sized steps.

import { Db } from "../plume/driver.ts";

// A service-account JSON, whole. JSON.parse here is strict in both
// directions — a field the record does not declare refuses the parse, and so
// does a declared field the document lacks — so this declares exactly what
// Google's console exports, all eleven fields, though only four are read.
// A future Google field would refuse a freshly rotated key at the door;
// when that happens the fix is one line here.
export type ServiceAccount = {
  type: string,
  project_id: string,
  private_key_id: string,
  private_key: string,
  client_email: string,
  client_id: string,
  auth_uri: string,
  token_uri: string,
  auth_provider_x509_cert_url: string,
  client_x509_cert_url: string,
  universe_domain: string,
};

export type VertexBearer = {
  ok: bool,
  token: string,
  // Epoch millis after which the token must not be reused. Held for the
  // cache; a caller never needs it.
  expiresAt: number,
  error: string,
};

function bearerRefused(why: string): VertexBearer {
  let out: VertexBearer = { ok: false, token: "", expiresAt: 0, error: why };
  return out;
}

// One cached token per service account, keyed by client_email — two agents
// on the same account share a token, two accounts never collide. Reassigned
// module state, like the script-run counter.
let vertexTokens: Map<string, VertexBearer> = new Map<string, VertexBearer>();

// How much of a token's life must remain for the cache to hand it out. Five
// minutes: a token that expires mid-run fails on the last round of a long
// agent turn, which is the most expensive possible moment to learn the time.
const VERTEX_EXPIRY_SLACK_MS: number = 300000;

export function vertexForget(): void {
  vertexTokens = new Map<string, VertexBearer>();
}

// Base64url of a file's bytes, via openssl: encode, then swap the alphabet
// and drop the padding. File-based throughout — spawnSync carries no stdin.
function b64urlOfFile(path: string): string {
  let res = child_process.spawnSync("openssl", ["base64", "-A", "-in", path]);
  if (res.status != 0) { return ""; }
  let out = "";
  let i: int = 0;
  while (i < res.stdout.length) {
    let c = res.stdout.charAt(i);
    if (c == "+") { out = out + "-"; }
    else if (c == "/") { out = out + "_"; }
    else if (c == "=" || c == "\n" || c == "\r") { }
    else { out = out + c; }
    i = i + 1;
  }
  return out;
}

// The access token for one service-account JSON, minted or cached.
//
// `now` is a parameter rather than a call to the clock so a test can hold
// time still — and hand it a token's whole lifetime in one tick.
export function vertexBearer(saJson: string, now: number): VertexBearer {
  let sa: ServiceAccount = { type: "", project_id: "", private_key_id: "", private_key: "",
    client_email: "", client_id: "", auth_uri: "", token_uri: "",
    auth_provider_x509_cert_url: "", client_x509_cert_url: "", universe_domain: "" };
  try {
    sa = JSON.parse<ServiceAccount>(saJson);
  } catch {
    return bearerRefused("the vertex credential is not a service-account JSON — paste the whole file Google exported, unedited");
  }
  if (sa.client_email == "" || sa.private_key == "" || sa.token_uri == "") {
    return bearerRefused("the service-account JSON is missing client_email, private_key or token_uri");
  }

  let held = vertexTokens.get(sa.client_email);
  if (held != null && held.ok && now < held.expiresAt - VERTEX_EXPIRY_SLACK_MS) {
    return held;
  }

  let minted = mintToken(sa, now);
  if (minted.ok) { vertexTokens.set(sa.client_email, minted); }
  return minted;
}

function mintToken(sa: ServiceAccount, now: number): VertexBearer {
  // A private working directory per mint. The private key touches disk —
  // openssl signs files, not arguments — so the directory is 0700, the files
  // live for milliseconds, and everything is removed on every path out.
  let dir = "/tmp/agents-vertex-" + crypto.randomUUID();
  try {
    fs.mkdirSync(dir, true);
  } catch {
    return bearerRefused("could not make a working directory to sign the vertex token request");
  }

  let out = mintTokenIn(dir, sa, now);
  try { fs.rmSync(dir, true); } catch { }
  return out;
}

function mintTokenIn(dir: string, sa: ServiceAccount, now: number): VertexBearer {
  let seconds = Math.floor(now / 1000);
  let header = "{\"alg\":\"RS256\",\"typ\":\"JWT\",\"kid\":" + JSON.stringify(sa.private_key_id) + "}";
  let claims = "{\"iss\":" + JSON.stringify(sa.client_email)
    + ",\"scope\":\"https://www.googleapis.com/auth/cloud-platform\""
    + ",\"aud\":" + JSON.stringify(sa.token_uri)
    + ",\"iat\":" + `${seconds}` + ",\"exp\":" + `${seconds + 3600}` + "}";

  try {
    fs.writeFileSync(dir + "/header", header);
    fs.writeFileSync(dir + "/claims", claims);
    fs.writeFileSync(dir + "/key.pem", sa.private_key);
  } catch {
    return bearerRefused("could not stage the vertex token request for signing");
  }

  let signingInput = b64urlOfFile(dir + "/header") + "." + b64urlOfFile(dir + "/claims");
  if (signingInput == ".") {
    return bearerRefused("openssl could not encode the vertex token request (is openssl installed?)");
  }
  try {
    fs.writeFileSync(dir + "/input", signingInput);
  } catch {
    return bearerRefused("could not stage the vertex token request for signing");
  }

  let signed = child_process.spawnSync("openssl",
    ["dgst", "-sha256", "-sign", dir + "/key.pem", "-out", dir + "/sig", dir + "/input"]);
  if (signed.status != 0) {
    // openssl's first stderr line names the real problem ("unable to load
    // key"), which is what an operator with a mispasted key needs to read.
    let detail = signed.stderr.split("\n")[0];
    return bearerRefused("the service-account key did not sign: " + detail);
  }
  let signature = b64urlOfFile(dir + "/sig");
  if (signature == "") {
    return bearerRefused("openssl could not encode the vertex signature");
  }

  let form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="
    + signingInput + "." + signature;
  let headers = new Map<string, string>();
  headers.set("content-type", "application/x-www-form-urlencoded");
  let res = http.request(sa.token_uri, "POST", form, headers);
  if (!res.ok) {
    return bearerRefused("no answer from " + sa.token_uri);
  }
  if (res.status != 200) {
    return bearerRefused("the token exchange was refused: HTTP " + `${res.status}` + " " + res.body.substring(0, 160));
  }

  let token = tokenFrom(res.body);
  if (token == "") {
    return bearerRefused("the token exchange answered without an access_token");
  }
  let minted: VertexBearer = { ok: true, token: token, expiresAt: now + 3600000, error: "" };
  return minted;
}

// access_token out of the exchange's answer, without trusting the rest of
// its shape.
function tokenFrom(body: string): string {
  let at = body.indexOf("\"access_token\"");
  if (at < 0) { return ""; }
  let colon = body.indexOf(":", at);
  let open = body.indexOf("\"", colon + 1);
  let close = body.indexOf("\"", open + 1);
  if (open < 0 || close < 0) { return ""; }
  return body.substring(open + 1, close);
}

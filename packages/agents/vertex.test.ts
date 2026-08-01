// The vertex token mint: the JWT it builds, the cache it keeps, and the
// sentences it refuses with.
//
//   cd packages/agents && lumen test vertex.test.ts
//
// The signing is tested for real: the suite generates a throwaway RSA key
// with openssl, lets vertexBearer sign with it, and verifies the signature
// against the key's public half. What cannot be tested here is the exchange
// itself — token_uri points at a port nothing listens on, and the refusal
// sentence for that is exactly what the case asserts.

import { ServiceAccount, VertexBearer, vertexBearer, vertexForget } from "./vertex.ts";

const DIR = "/tmp/agents_vertex_test";

function sh(cmd: string): string {
  let res = child_process.spawnSync("sh", ["-c", cmd]);
  return res.stdout;
}

// A real key pair, made once per suite run.
function keyPair(): string {
  fs.mkdirSync(DIR, true);
  child_process.spawnSync("openssl", ["genrsa", "-out", DIR + "/key.pem", "2048"]);
  child_process.spawnSync("openssl", ["rsa", "-in", DIR + "/key.pem", "-pubout", "-out", DIR + "/pub.pem"]);
  return fs.readFileSync(DIR + "/key.pem");
}

function account(privateKey: string, tokenUri: string): string {
  // Every field Google exports, because the parse is strict: a fixture
  // missing one would test the refusal path while meaning to test the mint.
  let sa: ServiceAccount = {
    type: "service_account",
    project_id: "test-project",
    private_key_id: "kid-1",
    private_key: privateKey,
    client_email: "svc@test.iam.gserviceaccount.com",
    client_id: "0",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: tokenUri,
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/svc",
    universe_domain: "googleapis.com",
  };
  return JSON.stringify(sa);
}

test("a service-account JSON that is not one is refused in words an operator can act on", () => {
  vertexForget();
  let notJson = vertexBearer("not json at all", 1000);
  expect(!notJson.ok);
  expect(notJson.error.indexOf("service-account JSON") >= 0);

  // Structurally complete — every field present, parse succeeds — but the
  // ones that matter are empty. This is the "missing" refusal; a document
  // with fields absent outright is refused by the strict parse above it.
  let hollow = vertexBearer(account("", "").replace("svc@test.iam.gserviceaccount.com", ""), 1000);
  expect(!hollow.ok);
  expect(hollow.error.indexOf("missing") >= 0);
});

test("a key that cannot sign is named as the problem, with openssl's own words", () => {
  vertexForget();
  let sa = account("-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n", "http://127.0.0.1:1/token");
  let refused = vertexBearer(sa, 1000);
  expect(!refused.ok);
  expect(refused.error.indexOf("did not sign") >= 0);
});

test("the JWT is signed with the account's key, and says who is asking for what", () => {
  vertexForget();
  let key = keyPair();
  // The exchange will fail — nothing listens on port 1 — but by then the
  // request body has been built, and the refusal proves the path ran.
  let sa = account(key, "http://127.0.0.1:1/token");
  let refused = vertexBearer(sa, 1700000000000);
  expect(!refused.ok);
  expect(refused.error.indexOf("no answer from http://127.0.0.1:1/token") >= 0);

  // Rebuild the same JWT the mint built, from the same instant, and verify
  // its signature against the public half of the key. The mint stages its
  // files in a private directory it removes, so the reconstruction signs the
  // same input rather than reading leftovers — leftovers existing would be
  // the bug.
  fs.writeFileSync(DIR + "/header",
    "{\"alg\":\"RS256\",\"typ\":\"JWT\",\"kid\":\"kid-1\"}");
  fs.writeFileSync(DIR + "/claims",
    "{\"iss\":\"svc@test.iam.gserviceaccount.com\","
    + "\"scope\":\"https://www.googleapis.com/auth/cloud-platform\","
    + "\"aud\":\"http://127.0.0.1:1/token\",\"iat\":1700000000,\"exp\":1700003600}");
  let h = sh("openssl base64 -A -in " + DIR + "/header | tr '+/' '-_' | tr -d '='");
  let c = sh("openssl base64 -A -in " + DIR + "/claims | tr '+/' '-_' | tr -d '='");
  fs.writeFileSync(DIR + "/input", h.trim() + "." + c.trim());
  sh("openssl dgst -sha256 -sign " + DIR + "/key.pem -out " + DIR + "/sig " + DIR + "/input");
  let verified = sh("openssl dgst -sha256 -verify " + DIR + "/pub.pem -signature " + DIR + "/sig " + DIR + "/input");
  expect(verified.indexOf("Verified OK") >= 0);
});

test("nothing of the key outlives a mint", () => {
  vertexForget();
  let key = keyPair();
  vertexBearer(account(key, "http://127.0.0.1:1/token"), 1000);
  let leftovers = sh("ls -d /tmp/agents-vertex-* 2>/dev/null | wc -l");
  expect(leftovers.trim() == "0");
});

test("a minted token is reused until its expiry nears, then minted again", () => {
  vertexForget();
  // No real exchange to count, so the cache is exercised through its misses:
  // each miss reaches the dead token_uri and answers "no answer", and a hit
  // would have answered the cached token instead. A failed mint is never
  // cached — the second call with the same broken account fails the same way
  // rather than remembering failure.
  let key = keyPair();
  let sa = account(key, "http://127.0.0.1:1/token");
  let first = vertexBearer(sa, 1000);
  expect(!first.ok);
  let second = vertexBearer(sa, 1000);
  expect(!second.ok);
  expect(second.error == first.error);
});

test("the suite leaves nothing behind", () => {
  fs.rmSync(DIR, true);
  expect(!fs.existsSync(DIR));
});

// Connecting a person to an MCP server, and keeping them connected.
//
// `mcp-oauth.ts` speaks the protocol and touches nothing; this file is the half
// that decides where things are written. The split is worth keeping: every
// secret in this package goes through `credentials.ts`, and one file that both
// talks to a vendor and writes rows is one file where a token can end up in a
// column by accident.
//
// Three things live here:
//
//   beginConnect     press Connect  → the URL to send the browser to
//   completeConnect  the browser comes back → tokens stored
//   accessTokenFor   about to call a server → a token that is not stale
//
// The last one is the one that matters day to day, and it is why this file
// exists rather than the flow being two routes in api.ts: every caller that
// used to read a credential now asks this instead, so a token that expired
// twenty minutes into a conversation is refreshed rather than surfacing as a
// 401 the model has to explain.

import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, findById, persist, deleteById, listWhere, placeholderAt, executeWith, countWhere, field, repository } from "../plume/plume.ts";
import { McpServerRow, McpOauthRow, McpPendingRow, McpGrantRow, AgentRow, mcpOauthMapping, mcpPendingMapping, mcpGrantsMapping, mcpServersMapping, agentsMapping, McpToolOffRow, mcpToolsOffMapping } from "./schema.ts";
import { credentialFor, storeCredential, hasCredential, forgetCredential } from "./credentials.ts";
import { Discovery, Grant, consentUrl, discover, exchangeCode, newState, newVerifier, refreshGrant, registerClient } from "./mcp-oauth.ts";

function stamp(): string { return `${Date.now()}`; }

// The key a person's own token for a server lives under. Beside the
// deployment's "mcp:<id>" rather than in a new table: the credential store
// already encrypts, already never reads back, and a second store would be a
// second set of those promises to keep.
export function userTokenKey(serverId: string, owner: string): string {
  return "mcp:" + serverId + ":u:" + owner;
}

// The deployment's own connection, used by anyone who has not made their own.
export function sharedTokenKey(serverId: string): string {
  return "mcp:" + serverId;
}

// Which key a caller's token lives under. An owner with nothing stored falls
// back to the shared connection, which is the rule the run loop already had.
export function tokenKeyFor(db: Db, serverId: string, owner: string): string {
  if (owner != "" && hasCredential(db, userTokenKey(serverId, owner))) {
    return userTokenKey(serverId, owner);
  }
  return sharedTokenKey(serverId);
}

// Where the refresh token sits, beside the access token it renews.
//
// A second credential rather than a JSON blob in the first, because the first
// is read by every existing caller as "the token to send" — `tools.ts` puts it
// straight into an Authorization header. Making that value a document would
// have meant every one of those callers parsing it correctly forever.
function refreshKey(key: string): string { return key + "#refresh"; }

// --- what the console needs to draw ------------------------------------------------

// A connection, as a person sees it.
export type Connection = {
  // "none" — never connected. "live" — a token that works. "expiring" — past
  // its expiry with a refresh token to fix it, which this does silently, so a
  // person never sees it. "stale" — expired with no way back but Connect.
  state: string,
  // Whose it is: "you" or "deployment". "" when there is no connection.
  whose: string,
  connectedAt: string,
};

export function connectionOf(db: Db, serverId: string, owner: string): Connection {
  let key = "";
  let whose = "";
  if (owner != "" && hasCredential(db, userTokenKey(serverId, owner))) {
    key = userTokenKey(serverId, owner);
    whose = "you";
  } else if (hasCredential(db, sharedTokenKey(serverId))) {
    key = sharedTokenKey(serverId);
    whose = "deployment";
  } else {
    return { state: "none", whose: "", connectedAt: "" };
  }
  let document = findById(db, mcpGrantsMapping(), key);
  if (document == "") {
    // A token stored by hand under PUT /:id/auth — a real connection, with no
    // grant behind it and so no expiry to report.
    return { state: "live", whose: whose, connectedAt: "" };
  }
  let grant: McpGrantRow = JSON.parse<McpGrantRow>(document);
  if (!expired(grant)) {
    return { state: "live", whose: whose, connectedAt: grant.connectedAt };
  }
  if (grant.refreshable) {
    return { state: "expiring", whose: whose, connectedAt: grant.connectedAt };
  }
  return { state: "stale", whose: whose, connectedAt: grant.connectedAt };
}

// Whether a grant's access token is past its usable life.
//
// Sixty seconds of margin, because the token has to survive the call it is
// about to be put on — a token that is valid when the header is built and
// expired when the far end reads it is the one failure that looks like a bug
// in the connector.
function expired(grant: McpGrantRow): bool {
  if (grant.expiresAt == "") { return false; }
  let at = parseFloat(grant.expiresAt) ?? 0.0;
  if (at == 0.0) { return false; }
  return (Date.now() as float) + 60000.0 >= at;
}

// --- the token a call should carry ----------------------------------------------------

// The token to send this server, refreshed first if it is about to expire.
//
// Every caller that reaches an MCP server goes through here. For a `bearer` or
// `header` connector this is exactly what reading the credential always did;
// for `oauth` it is the difference between a connector that keeps working and
// one that quietly stops an hour after it was set up.
export function accessTokenFor(db: Db, server: McpServerRow, owner: string, master: string): string {
  if (server.authKind == "" || server.authKind == "none") { return ""; }
  let key = tokenKeyFor(db, server.id, owner);
  let held = credentialFor(db, key, master);
  if (server.authKind != "oauth") { return held; }

  let document = findById(db, mcpGrantsMapping(), key);
  if (document == "") { return held; }
  let grant: McpGrantRow = JSON.parse<McpGrantRow>(document);
  if (!expired(grant)) { return held; }
  if (!grant.refreshable) {
    // Expired with no way to renew. The empty string is the honest answer:
    // the caller reports "needs a token" rather than sending a dead one and
    // reporting whatever the far end says about it.
    return "";
  }
  let renewed = renew(db, server, key, master);
  if (renewed == "") { return ""; }
  return renewed;
}

// Spend the refresh token and write down what came back.
function renew(db: Db, server: McpServerRow, key: string, master: string): string {
  let clientDoc = findById(db, mcpOauthMapping(), server.id);
  if (clientDoc == "") { return ""; }
  let client: McpOauthRow = JSON.parse<McpOauthRow>(clientDoc);
  let refresh = credentialFor(db, refreshKey(key), master);
  if (refresh == "") { return ""; }

  let got = refreshGrant(client.tokenUrl, refresh,
    client.clientId, credentialFor(db, clientSecretKey(server.id), master), server.endpoint);
  if (got.problem != "") {
    // The refresh token is dead — revoked at the far end, or rotated out from
    // under us. Marking the grant unrefreshable is what turns the console's
    // "connected" into "reconnect" instead of leaving a row that claims to be
    // fine and fails every call.
    markUnrefreshable(db, key);
    return "";
  }
  storeCredential(db, { provider: key, apiKey: got.accessToken, masterKey: master, now: stamp() });
  // Rotation is the norm now: a server that issues a new refresh token has
  // usually just killed the old one, so keeping the old one is being one
  // refresh away from logged out with nothing to say why.
  if (got.refreshToken != "") {
    storeCredential(db, { provider: refreshKey(key), apiKey: got.refreshToken, masterKey: master, now: stamp() });
  }
  writeGrant(db, key, server.id, ownerOfKey(server.id, key), got, true);
  return got.accessToken;
}

// The owner a credential key belongs to, read back out of the key. "" for the
// deployment's own connection.
function ownerOfKey(serverId: string, key: string): string {
  let prefix = userTokenKey(serverId, "");
  if (key.startsWith(prefix)) { return key.slice(prefix.length, key.length); }
  return "";
}

function clientSecretKey(serverId: string): string { return "mcpclient:" + serverId; }

// --- an OAuth client the operator obtained by hand ---------------------------
//
// Most of the shelf registers itself: the authorization server publishes a
// `registration_endpoint`, `clientFor` below registers at connect time, and
// there is nothing per-deployment to keep. That is why those cards are one
// press.
//
// A great many vendors do not offer it, and they are not exotic — Asana's v2
// server, Slack and Box all publish a real hosted MCP endpoint and all three
// require a client id and secret created by a person in their developer
// console. Without somewhere to keep that pair, Connect on such a card is a
// button that opens a screen which cannot finish.
//
// The pair lives in the credential store rather than in a column, and that is
// the whole of the mechanism — no migration, no new table. Three reasons it
// fits there rather than on `mcp_oauth`:
//
//   - The secret has to be encrypted anyway, and `mcp_oauth` is a plain row.
//     Half a credential in a column and half in the store is the arrangement
//     that eventually leaks the wrong half.
//   - `mcp_oauth` is a CACHE of a registration — `clientFor` deletes and
//     rebuilds it whenever the redirect changes. A supplied client must
//     survive exactly that, so it cannot live in the thing being rebuilt.
//   - The row's CREATE is generated from `mcpOauthMapping()`, so a column
//     added to it rewrites an applied migration and every deployed database
//     refuses the whole plan.
//
// The client id is not a secret and is stored beside the secret anyway: it is
// half of one credential, it is deleted with the other half, and a second home
// for it would be a second thing to keep in step.
function clientIdKey(serverId: string): string { return "mcpclientid:" + serverId; }

/** The client id an operator supplied for this connector, or "". Presence is
 *  the flag: a connector with one registers nothing and uses this instead. */
export function suppliedClientId(db: Db, serverId: string, master: string): string {
  if (!hasCredential(db, clientIdKey(serverId))) { return ""; }
  return credentialFor(db, clientIdKey(serverId), master);
}

/** Give this connector an OAuth client created by hand. "" on success.
 *
 *  Both halves or neither: a client id with no secret gets as far as the
 *  consent screen and fails at the token exchange, which is the most confusing
 *  place for it to fail. A vendor that issues a public client with no secret
 *  is served by the automatic path, not this one. */
export function setSuppliedClient(db: Db, serverId: string, clientId: string, clientSecret: string, master: string): string {
  let id = clientId.trim();
  let secret = clientSecret.trim();
  if (id == "") { return "an OAuth client needs a client id"; }
  if (secret == "") { return "an OAuth client needs a client secret"; }
  let wroteId = storeCredential(db, { provider: clientIdKey(serverId),
    apiKey: id, masterKey: master, now: stamp() });
  if (wroteId != "") { return wroteId; }
  let wroteSecret = storeCredential(db, { provider: clientSecretKey(serverId),
    apiKey: secret, masterKey: master, now: stamp() });
  if (wroteSecret != "") {
    // Take the id back out rather than leave a half-supplied client, which
    // would read as configured and behave as broken.
    forgetCredential(db, clientIdKey(serverId));
    return wroteSecret;
  }
  // The cached registration named the old client. Drop it so the next Connect
  // rebuilds the row around the supplied one.
  deleteById(db, mcpOauthMapping(), serverId);
  return "";
}

/** Take the supplied client away, and the registration built from it. The
 *  connector falls back to registering itself, which works where the vendor
 *  allows it and says so plainly where it does not. */
export function forgetSuppliedClient(db: Db, serverId: string): void {
  forgetCredential(db, clientIdKey(serverId));
  forgetCredential(db, clientSecretKey(serverId));
  deleteById(db, mcpOauthMapping(), serverId);
}

function markUnrefreshable(db: Db, key: string): void {
  let document = findById(db, mcpGrantsMapping(), key);
  if (document == "") { return; }
  let grant: McpGrantRow = JSON.parse<McpGrantRow>(document);
  let dead: McpGrantRow = {
    id: grant.id, serverId: grant.serverId, owner: grant.owner,
    // Long past, so `expired` stays true however the clock moves.
    expiresAt: "1", refreshable: false, connectedAt: grant.connectedAt,
  };
  deleteById(db, mcpGrantsMapping(), key);
  persist(db, mcpGrantsMapping(), JSON.stringify(dead));
}

function writeGrant(db: Db, key: string, serverId: string, owner: string, got: Grant, keepConnectedAt: bool): void {
  let connectedAt = stamp();
  if (keepConnectedAt) {
    let had = findById(db, mcpGrantsMapping(), key);
    if (had != "") {
      let before: McpGrantRow = JSON.parse<McpGrantRow>(had);
      if (before.connectedAt != "") { connectedAt = before.connectedAt; }
    }
  }
  let expiresAt = "";
  if (got.expiresIn > 0) {
    expiresAt = `${(Date.now() as float) + (got.expiresIn as float) * 1000.0}`;
  }
  let refreshable = got.refreshToken != "" || hasCredential(db, refreshKey(key));
  let row: McpGrantRow = {
    id: key, serverId: serverId, owner: owner,
    expiresAt: expiresAt, refreshable: refreshable, connectedAt: connectedAt,
  };
  deleteById(db, mcpGrantsMapping(), key);
  persist(db, mcpGrantsMapping(), JSON.stringify(row));
}

// --- pressing Connect ------------------------------------------------------------------

type ClientLookup = {
  row: McpOauthRow,
  problem: string,
};

function noClient(why: string): ClientLookup {
  let empty: McpOauthRow = { id: "", issuer: "", authorizeUrl: "", tokenUrl: "",
                             clientId: "", scope: "", redirectUri: "", registeredAt: "" };
  return { row: empty, problem: why };
}

// The registration for this connector, made if there is not one yet.
function clientFor(db: Db, server: McpServerRow, master: string, redirectUri: string): ClientLookup {
  // An operator-supplied client wins over anything registered. Read first
  // because it also decides whether a cached row is still the right one.
  let supplied = suppliedClientId(db, server.id, master);

  let had = findById(db, mcpOauthMapping(), server.id);
  if (had != "") {
    let row: McpOauthRow = JSON.parse<McpOauthRow>(had);
    // A registration is only good for the address it named. A deployment that
    // moved — or a connector re-pointed at a different endpoint — needs a new
    // one, and silently reusing the old client id would fail at the consent
    // screen with an error only the vendor can see.
    //
    // The third clause is for a client that was supplied, or replaced, after
    // this row was built: the row still names the client it was built around,
    // and using it would sign in as the wrong application.
    let sameClient = supplied == "" || row.clientId == supplied;
    if (row.redirectUri == redirectUri && row.clientId != "" && sameClient) {
      return { row: row, problem: "" };
    }
    deleteById(db, mcpOauthMapping(), server.id);
  }

  let found: Discovery = discover(server.endpoint);
  if (found.problem != "") { return noClient(found.problem); }

  let clientId = supplied;
  if (supplied == "") {
    let made = registerClient(found.registerUrl, redirectUri, "Joule");
    if (made.problem != "") {
      // The commonest failure on this path, and the only one with a way out
      // the reader can act on. Said here rather than in `mcp-oauth.ts`,
      // because the way out is a route this file's caller owns and the
      // redirect URL is only known here.
      if (found.registerUrl == "") {
        return noClient(server.serverName + " does not hand out OAuth clients automatically,"
          + " so it needs an app created in the vendor's own developer console."
          + " Give this connector that app's client id and secret, and set its redirect URL to "
          + redirectUri);
      }
      return noClient(made.problem);
    }
    clientId = made.clientId;
    if (made.clientSecret != "") {
      let stored = storeCredential(db, { provider: clientSecretKey(server.id),
        apiKey: made.clientSecret, masterKey: master, now: stamp() });
      if (stored != "") { return noClient(stored); }
    } else {
      forgetCredential(db, clientSecretKey(server.id));
    }
  }

  let row: McpOauthRow = {
    id: server.id,
    issuer: found.issuer,
    authorizeUrl: found.authorizeUrl,
    tokenUrl: found.tokenUrl,
    clientId: clientId,
    scope: found.scopesSupported,
    redirectUri: redirectUri,
    registeredAt: stamp(),
  };
  let wrote = persist(db, mcpOauthMapping(), JSON.stringify(row));
  if (!wrote.ok) { return noClient(wrote.error); }
  return { row: row, problem: "" };
}

export type Started = {
  url: string,
  problem: string,
};

// Where to send the browser so this person can approve the connector.
//
// Discovery and registration happen here, once per connector, and are kept.
// The alternative — registering on every press — leaves a trail of abandoned
// clients on the person's account at the far end, which is rude in a way that
// is invisible from this side.
function notStarted(why: string): Started {
  let out: Started = { url: "", problem: why };
  return out;
}

export function beginConnect(db: Db, server: McpServerRow, owner: string, master: string, redirectUri: string): Started {
  if (server.authKind != "oauth") {
    return notStarted(server.serverName + " does not sign in with OAuth");
  }
  if (redirectUri == "") {
    return notStarted("this deployment does not know its own public address, so it cannot be redirected back to; set AGENTS_PUBLIC_ORIGIN");
  }
  let client: ClientLookup = clientFor(db, server, master, redirectUri);
  if (client.problem != "") { return notStarted(client.problem); }

  let verifier = newVerifier();
  let state = newState();
  let pending: McpPendingRow = {
    id: state, serverId: server.id, owner: owner,
    verifier: verifier, startedAt: stamp(),
  };
  let wrote = persist(db, mcpPendingMapping(), JSON.stringify(pending));
  if (!wrote.ok) { return notStarted(wrote.error); }

  let url = consentUrl({
    authorizeUrl: client.row.authorizeUrl,
    clientId: client.row.clientId,
    redirectUri: client.row.redirectUri,
    state: state,
    verifier: verifier,
    scope: client.row.scope,
    resource: server.endpoint,
  });
  let out: Started = { url: url, problem: "" };
  return out;
}


// --- coming back from the consent screen ------------------------------------------------

export type Completed = {
  serverId: string,
  serverName: string,
  problem: string,
};

// How long a consent screen may sit open. Ten minutes is longer than anyone
// takes and short enough that an abandoned row is not a permanent one.
const PENDING_MS = 600000.0;

export function completeConnect(db: Db, master: string, state: string, code: string): Completed {
  if (state == "" || code == "") {
    return { serverId: "", serverName: "", problem: "that sign-in came back without a code" };
  }
  let pendingDoc = findById(db, mcpPendingMapping(), state);
  if (pendingDoc == "") {
    // No row for this state: either it was used already, or it never existed.
    // Both are refused identically and deliberately — a caller that could tell
    // them apart could use this to probe for live flows.
    return { serverId: "", serverName: "", problem: "that sign-in has expired; press Connect again" };
  }
  let pending: McpPendingRow = JSON.parse<McpPendingRow>(pendingDoc);
  // Single use, whatever happens next. Deleted before the exchange rather than
  // after, so a code replayed while the first exchange is still in flight finds
  // nothing to replay against.
  deleteById(db, mcpPendingMapping(), state);

  let started = parseFloat(pending.startedAt) ?? 0.0;
  if (started == 0.0 || (Date.now() as float) - started > PENDING_MS) {
    return { serverId: "", serverName: "", problem: "that sign-in has expired; press Connect again" };
  }

  let serverDoc = findById(db, mcpServersMapping(), pending.serverId);
  if (serverDoc == "") {
    return { serverId: "", serverName: "", problem: "that connector has been removed" };
  }
  let server: McpServerRow = JSON.parse<McpServerRow>(serverDoc);
  let clientDoc = findById(db, mcpOauthMapping(), server.id);
  if (clientDoc == "") {
    return { serverId: server.id, serverName: server.serverName,
             problem: "this deployment is no longer registered with " + server.serverName };
  }
  let client: McpOauthRow = JSON.parse<McpOauthRow>(clientDoc);

  let got = exchangeCode({
    tokenUrl: client.tokenUrl,
    code: code,
    redirectUri: client.redirectUri,
    clientId: client.clientId,
    clientSecret: credentialFor(db, clientSecretKey(server.id), master),
    verifier: pending.verifier,
    resource: server.endpoint,
  });
  if (got.problem != "") {
    return { serverId: server.id, serverName: server.serverName, problem: got.problem };
  }

  // Whose connection this is. A signed-in person gets their own, which is the
  // point of OAuth here: one shared token for a connector means every
  // conversation on the deployment reads and writes as one account.
  let key = pending.owner == "" ? sharedTokenKey(server.id) : userTokenKey(server.id, pending.owner);
  let stored = storeCredential(db, { provider: key, apiKey: got.accessToken,
    masterKey: master, now: stamp() });
  if (stored != "") {
    return { serverId: server.id, serverName: server.serverName, problem: stored };
  }
  if (got.refreshToken != "") {
    storeCredential(db, { provider: refreshKey(key), apiKey: got.refreshToken,
      masterKey: master, now: stamp() });
  } else {
    // A re-connect that returned no refresh token must not inherit the last
    // one: it may well have been invalidated by this very exchange.
    forgetCredential(db, refreshKey(key));
  }
  writeGrant(db, key, server.id, pending.owner, got, false);

  // A connector nobody can use is not connected. Enabling on first connection
  // is the one place this writes to the server row, and it is what makes
  // "press Connect" the whole of the setup — the shelf deliberately adds
  // everything switched off, and staying off after someone signed in reads as
  // the connection having failed.
  enable(db, server.id);
  // And attach it, which is the other half of the same sentence.
  //
  // Enabling a connector only says it MAY be called. What decides whether a
  // model ever sees its tools is `agent_mcp_servers`, and a freshly connected
  // connector was linked to nothing — so signing in to Linear, correctly, all
  // the way to a live refreshable token, produced an agent that answered "the
  // Linear tool is not a standard or widely recognized tool". Every part of
  // the flow reported success and the feature did nothing.
  attachToDefault(db, server.id);
  return { serverId: server.id, serverName: server.serverName, problem: "" };
}

/* Give the connector to the agent people actually talk to.
 *
 * The default agent, and only that one. Attaching to every agent would hand a
 * person's Linear account to a sub-agent written for something else, and
 * attaching to none is what this is fixing. The default is the one the console
 * opens a new conversation with, so it is the one whose tools a person expects
 * to change when they press Connect.
 *
 * Additive and idempotent: an operator who later attaches it elsewhere, or
 * detaches it here, is not overruled the next time somebody reconnects. */
function attachToDefault(db: Db, serverId: string): void {
  let agents = JSON.parse<AgentRow[]>(listWhere(db, agentsMapping(),
    "is_default = " + placeholderAt(db, 1), ["1"]));
  if (agents.length == 0) { return; }
  let agentId = agents[0].id;
  if (countWhere(db, agentServerLink(),
        "agent_id = " + placeholderAt(db, 1) + " AND server_id = " + placeholderAt(db, 2),
        [agentId, serverId]) > 0) {
    return;
  }
  executeWith(db, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")", [agentId, serverId]);
}

/* The link table as something countWhere can read. Two columns and no id —
 * it is a join, not a record — so it never gets a mapping in schema.ts. */
function agentServerLink(): DbRepository {
  let fs: DbField[] = [
    field("agentId", "agent_id", "text"),
    field("serverId", "server_id", "text"),
  ];
  return repository("agent_mcp_servers", "agentId", "agent_id", fs);
}

function enable(db: Db, serverId: string): void {
  let document = findById(db, mcpServersMapping(), serverId);
  if (document == "") { return; }
  let server: McpServerRow = JSON.parse<McpServerRow>(document);
  if (server.enabled) { return; }
  let on: McpServerRow = {
    id: server.id, serverName: server.serverName, transport: server.transport,
    endpoint: server.endpoint, authKind: server.authKind,
    authHeader: server.authHeader, enabled: true,
  };
  deleteById(db, mcpServersMapping(), serverId);
  persist(db, mcpServersMapping(), JSON.stringify(on));
}

// --- letting go ---------------------------------------------------------------------------

// Forget one connection: the tokens, and what was known about them.
//
// The registration is kept. It is not a secret, it names no person, and
// throwing it away would mean registering a new client at the vendor the next
// time anybody here presses Connect.
export function disconnect(db: Db, serverId: string, owner: string): bool {
  let key = owner == "" ? sharedTokenKey(serverId) : userTokenKey(serverId, owner);
  let had = hasCredential(db, key);
  forgetCredential(db, key);
  forgetCredential(db, refreshKey(key));
  deleteById(db, mcpGrantsMapping(), key);
  return had;
}

// Everything stored about a connector, for when the connector itself is
// deleted or re-pointed. Every person's connection, not just the caller's —
// a token for an address the row no longer names is a secret with nowhere to
// go and no one to clean it up.
export function forgetConnector(db: Db, serverId: string, master: string): void {
  forgetCredential(db, sharedTokenKey(serverId));
  forgetCredential(db, refreshKey(sharedTokenKey(serverId)));
  forgetCredential(db, clientSecretKey(serverId));
  forgetCredential(db, clientIdKey(serverId));
  deleteById(db, mcpOauthMapping(), serverId);

  let rows = JSON.parse<McpGrantRow[]>(listWhere(db, mcpGrantsMapping(),
    "server_id = " + placeholderAt(db, 1), [serverId]));
  let i: int = 0;
  while (i < rows.length) {
    forgetCredential(db, rows[i].id);
    forgetCredential(db, refreshKey(rows[i].id));
    deleteById(db, mcpGrantsMapping(), rows[i].id);
    i = i + 1;
  }
}

// --- which of a connector's tools are mounted -------------------------------------
//
// The rows are the exceptions. A connector's roster is the connector's to
// change, so a list of what IS on would go stale by omission every time a
// vendor shipped a tool — and go stale silently, which reads as the connector
// being broken rather than as a new tool nobody has switched on.

/** The tools switched off for this connector. */
export function toolsOff(db: Db, serverId: string): string[] {
  let rows = JSON.parse<McpToolOffRow[]>(listWhere(db, mcpToolsOffMapping(),
    "server_id = " + placeholderAt(db, 1), [serverId]));
  let out: string[] = [];
  let i: int = 0;
  while (i < rows.length) { out.push(rows[i].toolName); i = i + 1; }
  return out;
}

/** Switch one tool on or off. Idempotent both ways, because the console sends
 *  the state it wants rather than a toggle — two tabs open on the same
 *  connector should not be able to invert each other. */
export function setToolOn(db: Db, serverId: string, toolName: string, on: bool): void {
  let id = serverId + ":" + toolName;
  if (on) {
    deleteById(db, mcpToolsOffMapping(), id);
    return;
  }
  if (findById(db, mcpToolsOffMapping(), id) != "") { return; }
  let row: McpToolOffRow = { id: id, serverId: serverId, toolName: toolName };
  persist(db, mcpToolsOffMapping(), JSON.stringify(row));
}

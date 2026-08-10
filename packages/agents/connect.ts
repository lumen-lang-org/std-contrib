import { Db } from "../plume/driver.ts";
import { DbField, DbRepository, findById, persist, deleteById, listWhere, placeholderAt, executeWith, countWhere, field, repository } from "../plume/plume.ts";
import { McpServerRow, McpOauthRow, McpPendingRow, McpGrantRow, AgentRow, mcpOauthMapping, mcpPendingMapping, mcpGrantsMapping, mcpServersMapping, agentsMapping, McpToolOffRow, mcpToolsOffMapping } from "./schema.ts";
import { credentialFor, storeCredential, hasCredential, forgetCredential } from "./credentials.ts";
import { Discovery, Grant, consentUrl, discover, exchangeCode, newState, newVerifier, refreshGrant, registerClient } from "./mcp-oauth.ts";

function stamp(): string {
  return `${Date.now()}`;
}

export function userTokenKey(serverId: string, owner: string): string {
  return "mcp:" + serverId + ":u:" + owner;
}

export function sharedTokenKey(serverId: string): string {
  return "mcp:" + serverId;
}

export function tokenKeyFor(db: Db, serverId: string, owner: string): string {
  if (owner != "" && hasCredential(db, userTokenKey(serverId, owner))) {
    return userTokenKey(serverId, owner);
  }
  return sharedTokenKey(serverId);
}

function refreshKey(key: string): string {
  return key + "#refresh";
}

export type Connection = {
  state: string,
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

function expired(grant: McpGrantRow): bool {
  if (grant.expiresAt == "") {
    return false;
  }
  let at = parseFloat(grant.expiresAt) ?? 0.0;
  if (at == 0.0) {
    return false;
  }
  return (Date.now() as float) + 60000.0 >= at;
}

export function accessTokenFor(db: Db, server: McpServerRow, owner: string, master: string): string {
  if (server.authKind == "" || server.authKind == "none") {
    return "";
  }
  let key = tokenKeyFor(db, server.id, owner);
  let held = credentialFor(db, key, master);
  if (server.authKind != "oauth") {
    return held;
  }

  let document = findById(db, mcpGrantsMapping(), key);
  if (document == "") {
    return held;
  }
  let grant: McpGrantRow = JSON.parse<McpGrantRow>(document);
  if (!expired(grant)) {
    return held;
  }
  if (!grant.refreshable) {
    return "";
  }
  let renewed = renew(db, server, key, master);
  if (renewed == "") {
    return "";
  }
  return renewed;
}

function renew(db: Db, server: McpServerRow, key: string, master: string): string {
  let clientDoc = findById(db, mcpOauthMapping(), server.id);
  if (clientDoc == "") {
    return "";
  }
  let client: McpOauthRow = JSON.parse<McpOauthRow>(clientDoc);
  let refresh = credentialFor(db, refreshKey(key), master);
  if (refresh == "") {
    return "";
  }

  let got = refreshGrant(client.tokenUrl, refresh,
    client.clientId, credentialFor(db, clientSecretKey(server.id), master), server.endpoint);
  if (got.problem != "") {
    markUnrefreshable(db, key);
    return "";
  }
  storeCredential(db, { provider: key, apiKey: got.accessToken, masterKey: master, now: stamp() });
  if (got.refreshToken != "") {
    storeCredential(db, { provider: refreshKey(key), apiKey: got.refreshToken, masterKey: master, now: stamp() });
  }
  writeGrant(db, key, server.id, ownerOfKey(server.id, key), got, true);
  return got.accessToken;
}

function ownerOfKey(serverId: string, key: string): string {
  let prefix = userTokenKey(serverId, "");
  if (key.startsWith(prefix)) {
    return key.slice(prefix.length, key.length);
  }
  return "";
}

function clientSecretKey(serverId: string): string {
  return "mcpclient:" + serverId;
}

function clientIdKey(serverId: string): string {
  return "mcpclientid:" + serverId;
}

export function suppliedClientId(db: Db, serverId: string, master: string): string {
  if (!hasCredential(db, clientIdKey(serverId))) {
    return "";
  }
  return credentialFor(db, clientIdKey(serverId), master);
}

export function setSuppliedClient(db: Db, serverId: string, clientId: string, clientSecret: string, master: string): string {
  let id = clientId.trim();
  let secret = clientSecret.trim();
  if (id == "") {
    return "an OAuth client needs a client id";
  }
  if (secret == "") {
    return "an OAuth client needs a client secret";
  }
  let wroteId = storeCredential(db, { provider: clientIdKey(serverId),
    apiKey: id, masterKey: master, now: stamp() });
  if (wroteId != "") {
    return wroteId;
  }
  let wroteSecret = storeCredential(db, { provider: clientSecretKey(serverId),
    apiKey: secret, masterKey: master, now: stamp() });
  if (wroteSecret != "") {
    forgetCredential(db, clientIdKey(serverId));
    return wroteSecret;
  }
  deleteById(db, mcpOauthMapping(), serverId);
  return "";
}

export function forgetSuppliedClient(db: Db, serverId: string): void {
  forgetCredential(db, clientIdKey(serverId));
  forgetCredential(db, clientSecretKey(serverId));
  deleteById(db, mcpOauthMapping(), serverId);
}

function markUnrefreshable(db: Db, key: string): void {
  let document = findById(db, mcpGrantsMapping(), key);
  if (document == "") {
    return;
  }
  let grant: McpGrantRow = JSON.parse<McpGrantRow>(document);
  let dead: McpGrantRow = {
    id: grant.id, serverId: grant.serverId, owner: grant.owner,
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
      if (before.connectedAt != "") {
        connectedAt = before.connectedAt;
      }
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

type ClientLookup = {
  row: McpOauthRow,
  problem: string,
};

function noClient(why: string): ClientLookup {
  let empty: McpOauthRow = { id: "", issuer: "", authorizeUrl: "", tokenUrl: "",
                             clientId: "", scope: "", redirectUri: "", registeredAt: "" };
  return { row: empty, problem: why };
}

function clientFor(db: Db, server: McpServerRow, master: string, redirectUri: string): ClientLookup {
  let supplied = suppliedClientId(db, server.id, master);

  let had = findById(db, mcpOauthMapping(), server.id);
  if (had != "") {
    let row: McpOauthRow = JSON.parse<McpOauthRow>(had);
    let sameClient = supplied == "" || row.clientId == supplied;
    if (row.redirectUri == redirectUri && row.clientId != "" && sameClient) {
      return { row: row, problem: "" };
    }
    deleteById(db, mcpOauthMapping(), server.id);
  }

  let found: Discovery = discover(server.endpoint);
  if (found.problem != "") {
    return noClient(found.problem);
  }

  let clientId = supplied;
  if (supplied == "") {
    let made = registerClient(found.registerUrl, redirectUri, "Joule");
    if (made.problem != "") {
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
      if (stored != "") {
        return noClient(stored);
      }
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
  if (!wrote.ok) {
    return noClient(wrote.error);
  }
  return { row: row, problem: "" };
}

export type Started = {
  url: string,
  problem: string,
};

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
  if (client.problem != "") {
    return notStarted(client.problem);
  }

  let verifier = newVerifier();
  let state = newState();
  let pending: McpPendingRow = {
    id: state, serverId: server.id, owner: owner,
    verifier: verifier, startedAt: stamp(),
  };
  let wrote = persist(db, mcpPendingMapping(), JSON.stringify(pending));
  if (!wrote.ok) {
    return notStarted(wrote.error);
  }

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


export type Completed = {
  serverId: string,
  serverName: string,
  problem: string,
};

const PENDING_MS = 600000.0;

export function completeConnect(db: Db, master: string, state: string, code: string): Completed {
  if (state == "" || code == "") {
    return { serverId: "", serverName: "", problem: "that sign-in came back without a code" };
  }
  let pendingDoc = findById(db, mcpPendingMapping(), state);
  if (pendingDoc == "") {
    return { serverId: "", serverName: "", problem: "that sign-in has expired; press Connect again" };
  }
  let pending: McpPendingRow = JSON.parse<McpPendingRow>(pendingDoc);
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
    forgetCredential(db, refreshKey(key));
  }
  writeGrant(db, key, server.id, pending.owner, got, false);

  enable(db, server.id);
  attachToDefault(db, server.id);
  return { serverId: server.id, serverName: server.serverName, problem: "" };
}

function attachToDefault(db: Db, serverId: string): void {
  let agents = JSON.parse<AgentRow[]>(listWhere(db, agentsMapping(),
    "is_default = " + placeholderAt(db, 1), ["1"]));
  if (agents.length == 0) {
    return;
  }
  let agentId = agents[0].id;
  if (countWhere(db, agentServerLink(),
        "agent_id = " + placeholderAt(db, 1) + " AND server_id = " + placeholderAt(db, 2),
        [agentId, serverId]) > 0) {
    return;
  }
  executeWith(db, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")", [agentId, serverId]);
}

function agentServerLink(): DbRepository {
  let fs: DbField[] = [
    field("agentId", "agent_id", "text"),
    field("serverId", "server_id", "text"),
  ];
  return repository({ table: "agent_mcp_servers", idField: "agentId", idColumn: "agent_id", fields: fs });
}

function enable(db: Db, serverId: string): void {
  let document = findById(db, mcpServersMapping(), serverId);
  if (document == "") {
    return;
  }
  let server: McpServerRow = JSON.parse<McpServerRow>(document);
  if (server.enabled) {
    return;
  }
  let on: McpServerRow = {
    id: server.id, serverName: server.serverName, transport: server.transport,
    endpoint: server.endpoint, authKind: server.authKind,
    authHeader: server.authHeader, enabled: true,
  };
  deleteById(db, mcpServersMapping(), serverId);
  persist(db, mcpServersMapping(), JSON.stringify(on));
}

export function disconnect(db: Db, serverId: string, owner: string): bool {
  let key = owner == "" ? sharedTokenKey(serverId) : userTokenKey(serverId, owner);
  let had = hasCredential(db, key);
  forgetCredential(db, key);
  forgetCredential(db, refreshKey(key));
  deleteById(db, mcpGrantsMapping(), key);
  return had;
}

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

export function toolsOff(db: Db, serverId: string): string[] {
  let rows = JSON.parse<McpToolOffRow[]>(listWhere(db, mcpToolsOffMapping(),
    "server_id = " + placeholderAt(db, 1), [serverId]));
  let out: string[] = [];
  let i: int = 0;
  while (i < rows.length) {
    out.push(rows[i].toolName);
    i = i + 1;
  }
  return out;
}

export function setToolOn(db: Db, serverId: string, toolName: string, on: bool): void {
  let id = serverId + ":" + toolName;
  if (on) {
    deleteById(db, mcpToolsOffMapping(), id);
    return;
  }
  if (findById(db, mcpToolsOffMapping(), id) != "") {
    return;
  }
  let row: McpToolOffRow = { id: id, serverId: serverId, toolName: toolName };
  persist(db, mcpToolsOffMapping(), JSON.stringify(row));
}

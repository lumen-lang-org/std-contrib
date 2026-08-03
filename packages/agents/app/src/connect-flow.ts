// Pressing Connect on a connector, from wherever it was pressed.
//
// Two surfaces offer it — the directory overlay off the rail, and the
// Connectors tab in Settings — and they are two places a person legitimately
// reaches for the same thing. The flow itself is fiddly in ways that are easy
// to get subtly wrong on a second copy (the popup has to be opened inside the
// click, the message has to be origin-checked, a cancelled sign-in reports
// nothing at all), so there is one copy and both call it.

import { createServer, listServers, startConnect } from "./api.js";
import type { ServerRow } from "./api.js";
import type { CatalogueEntry } from "./mcp-gallery.js";

/** What the caller needs afterwards: the refreshed rows, and a sentence to put
 *  on screen when it did not work. `problem` is "" on success and on a
 *  cancelled sign-in that the person clearly meant to cancel. */
export type ConnectResult = {
  servers: ServerRow[];
  problem: string;
};

/** Press Connect on a catalogue card: make the row if it is not there yet,
 *  then open the consent screen.
 *
 *  The row has to exist first — the flow is keyed by server id, and the engine
 *  registers this deployment with the connector using that row's endpoint.
 *  Doing both here rather than asking for Add and then Connect is the
 *  difference between one press and three. */
export async function connectEntry(entry: CatalogueEntry, servers: ServerRow[]): Promise<ConnectResult> {
  // Opened first, and synchronously: a window opened after an await is opened
  // outside the click's own turn, which is exactly what every browser's popup
  // blocker exists to stop.
  const popup = window.open("", "joule-connect", "width=560,height=760");
  try {
    let row = servers.find((s) => s.endpoint === entry.endpoint);
    if (row === undefined) {
      row = await createServer(freshRow(entry, servers));
    }
    return await consent(row.id, popup);
  } catch (e) {
    if (popup !== null) { popup.close(); }
    return { servers, problem: said(e) };
  }
}

/** The same, for a connector that is already a row — the Reconnect path, and
 *  the status cell in the Connectors table. */
export async function connectServer(serverId: string, servers: ServerRow[]): Promise<ConnectResult> {
  const popup = window.open("", "joule-connect", "width=560,height=760");
  try {
    return await consent(serverId, popup);
  } catch (e) {
    if (popup !== null) { popup.close(); }
    return { servers, problem: said(e) };
  }
}

/** A row for a card that has never been added here.
 *
 *  Named and identified from the card rather than by a UUID: an id is in the
 *  URL of every route about this server and in the key its tokens are stored
 *  under, and "linear-2" reads better than a hex block in both places. */
function freshRow(entry: CatalogueEntry, servers: ServerRow[]): ServerRow {
  const stem = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const names = new Set(servers.map((s) => s.serverName));
  let name = stem;
  let n = 2;
  while (names.has(name)) { name = stem + "-" + String(n); n = n + 1; }
  const ids = new Set(servers.map((s) => s.id));
  let id = name;
  let k = 2;
  while (ids.has(id)) { id = name + "-" + String(k); k = k + 1; }
  return {
    id, serverName: name, transport: entry.transport, endpoint: entry.endpoint,
    // Switched off until the sign-in lands. The engine turns it on when the
    // tokens arrive, so a connector is never both enabled and unable to
    // authenticate — which is the state that fails every tool call it is asked
    // for and reads, from the outside, as the connector being broken.
    authKind: "oauth", authHeader: "", enabled: false,
  };
}

async function consent(serverId: string, popup: Window | null): Promise<ConnectResult> {
  const { url } = await startConnect(serverId);
  if (popup === null) {
    return {
      servers: await listServers(),
      problem: "your browser blocked the sign-in window — allow popups for this site and try again",
    };
  }
  popup.location.replace(url);
  const refused = await settled(popup);
  return { servers: await listServers(), problem: refused };
}

/** Wait for the callback page to report back.
 *
 *  Two ways out, because neither alone is enough: the popup posts a message
 *  when it lands on our own callback, and a person who closes the window
 *  without approving posts nothing at all. Watching `closed` is what turns
 *  that second case from a button that hangs into a card that goes back to
 *  saying Connect. */
function settled(popup: Window): Promise<string> {
  return new Promise((done) => {
    let over = false;
    let problem = "";
    const finish = () => {
      if (over) { return; }
      over = true;
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
      clearTimeout(giveUp);
      // The popup closes itself on success; on a refusal it lingers for a few
      // seconds so the reason can be read. Either way it is ours to tidy.
      try { popup.close(); } catch { /* already gone */ }
      done(problem);
    };
    const onMessage = (ev: MessageEvent) => {
      // Same origin only, and our own shape. A message from anywhere else is
      // somebody else's page talking, and acting on it would let any site that
      // can open this one claim a connector had been approved.
      if (ev.origin !== window.location.origin) { return; }
      const heard = ev.data as { joule?: string; ok?: boolean } | null;
      if (heard === null || typeof heard !== "object" || heard.joule !== "connector") { return; }
      if (heard.ok === false) {
        problem = "that connector was not connected — the sign-in was refused or cancelled";
      }
      finish();
    };
    window.addEventListener("message", onMessage);
    const watch = setInterval(() => { if (popup.closed) { finish(); } }, 700);
    // Nobody spends five minutes on a consent screen. This is only here so a
    // person who wanders off does not leave a listener and a timer running for
    // the rest of the session.
    const giveUp = setTimeout(finish, 300000);
  });
}

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

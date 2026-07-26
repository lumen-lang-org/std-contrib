// The client, against whatever is listening.
//
//   lumen run ws-client-demo.ts
import { Connection, Exchange, connectWebSocket, sendText, sendPing, receive, closeConnection } from "./client.ts";

function main(): void {
  let port = 9007;
  let ws = connectWebSocket("127.0.0.1", port, "/chat");
  if (!ws.ok) { console.log("connect failed: " + ws.error); return; }
  console.log("connected");

  sendText(ws, "hello");
  let got = receive(ws);
  ws = got.conn;
  console.log("small  ok=" + `${got.received.ok}` + " kind=" + got.received.kind + " msg=" + got.received.message.slice(0, 30));

  sendText(ws, "y".repeat(5000));
  got = receive(ws);
  ws = got.conn;
  console.log("large  ok=" + `${got.received.ok}` + " bytes=" + `${got.received.message.length}`);

  closeConnection(ws, 1000, "done");
  console.log("closed");
}
main();

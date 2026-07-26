// A WebSocket echo server, for verifying against a real browser.
//
//   lumen run echo-server.ts   then connect from a browser to ws://localhost:9001/
import { Peer, serveWebSocket, send } from "./server.ts";

function main(): void {
  console.log("websocket echo on 9001");
  serveWebSocket(9001, (peer: Peer, message: string) => {
    console.log("recv " + `${message.length}` + " bytes on " + peer.path);
    send(peer, "echo:" + message);
  });
}
main();

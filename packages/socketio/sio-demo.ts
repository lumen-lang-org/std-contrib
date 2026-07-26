// A socket.io server the official browser client can connect to.
//
//   lumen run sio-demo.ts
import { Client, serveSocketIO, emit, ack } from "./server.ts";

function main(): void {
  console.log("socket.io on 9020");
  serveSocketIO(9020, (client: Client, name: string, argsJson: string) => {
    console.log("event " + name + " args=" + argsJson.slice(0, 60));
    if (name == "hello") {
      emit(client, "greeting", "\"hi from lumen\"");
    }
    if (name == "add") {
      emit(client, "sum", "42");
    }
  });
}
main();

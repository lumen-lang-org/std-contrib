// A stream a browser can subscribe to.
//
//   lumen run events-demo.ts   then: new EventSource("http://127.0.0.1:9010/events")
import { EventStream, serveEvents, pushEvent, pushEventWithId, pushComment, retryFrame } from "./sse.ts";

function main(): void {
  console.log("events on 9010");
  serveEvents(9010, (stream: EventStream) => {
    console.log("subscriber on " + stream.path);
    // A token stream, the shape an agent's answer would take.
    pushEvent(stream, "token", "Hel");
    pushEvent(stream, "token", "lo ");
    pushEvent(stream, "token", "there");
    // Multi-line, to prove a newline does not end the event early.
    pushEvent(stream, "note", "line one\nline two");
    // With an id, which is what a reconnect resumes from.
    pushEventWithId(stream, { id: "7", name: "done", data: "complete" });
    pushComment(stream, "heartbeat");
  });
}
main();

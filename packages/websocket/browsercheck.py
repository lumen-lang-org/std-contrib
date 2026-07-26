#!/usr/bin/env python3
"""Drive a real browser's WebSocket against our server and report what it saw.

Two harness faults cost earlier attempts, both recorded here so they are not
repeated: `about:blank` has an opaque origin and Chromium refuses the dial, and
the Langfuse page serves a Content-Security-Policy whose connect-src blocks
another port. So this navigates to a plain page with no CSP first.
"""
import json
import sys
import time
import urllib.request

sys.path.insert(0, "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad")
from shot import CDP

PAGE = "http://127.0.0.1:9005/"
WS = "ws://127.0.0.1:9001/chat"


def main():
    targets = json.load(urllib.request.urlopen("http://localhost:9222/json"))
    page = [t for t in targets if t["type"] == "page"][0]
    c = CDP(page["webSocketDebuggerUrl"])
    c.call("Page.enable")
    c.call("Runtime.enable")

    c.call("Page.navigate", {"url": PAGE})
    time.sleep(3)
    where = c.call("Runtime.evaluate", {"expression": "location.href", "returnByValue": True})
    print("page:", where["result"].get("value"))

    arm = """
      window.__log = [];
      window.__w = new WebSocket(%s);
      __w.onopen    = () => { __log.push("open"); __w.send("hello"); };
      __w.onmessage = (e) => __log.push("recv(" + e.data.length + "):" + e.data.slice(0, 40));
      __w.onerror   = () => __log.push("error");
      __w.onclose   = (e) => __log.push("close:" + e.code + " clean=" + e.wasClean);
      "armed"
    """ % json.dumps(WS)
    r = c.call("Runtime.evaluate", {"expression": arm, "returnByValue": True})
    print("armed:", r["result"].get("value"), r.get("exceptionDetails", {}).get("text", ""))
    time.sleep(3)

    # A payload that forces the 16-bit length in both directions.
    c.call("Runtime.evaluate", {"expression": 'window.__w.send("x".repeat(5000)); "big"'})
    time.sleep(2)

    state = c.call("Runtime.evaluate", {"expression": "window.__w.readyState", "returnByValue": True})
    print("readyState before close:", state["result"].get("value"), "(1 = OPEN)")

    c.call("Runtime.evaluate", {"expression": 'window.__w.close(1000, "done"); "closing"'})
    time.sleep(2)

    out = c.call("Runtime.evaluate", {
        "expression": "JSON.stringify(window.__log)", "returnByValue": True,
    })["result"]["value"]
    for line in json.loads(out):
        print("browser:", line)


if __name__ == "__main__":
    main()

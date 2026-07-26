import json, sys, time, urllib.request
sys.path.insert(0, "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad")
from shot import CDP

t = [x for x in json.load(urllib.request.urlopen("http://localhost:9222/json")) if x["type"] == "page"][0]
c = CDP(t["webSocketDebuggerUrl"])
c.call("Page.enable"); c.call("Runtime.enable")
c.call("Page.navigate", {"url": "http://127.0.0.1:9021/"})
time.sleep(3)
print("io loaded:", c.call("Runtime.evaluate", {"expression": "typeof io", "returnByValue": True})["result"].get("value"))

c.call("Runtime.evaluate", {"expression": """
  window.__log = [];
  const s = io("http://127.0.0.1:9020", { transports: ["websocket"], reconnection: false });
  window.__s = s;
  s.on("connect",    () => { window.__log.push("connect id=" + s.id); s.emit("hello", "world"); });
  s.on("greeting",   (m) => window.__log.push("greeting:" + m));
  s.on("sum",        (m) => window.__log.push("sum:" + m));
  s.on("connect_error", (e) => window.__log.push("connect_error:" + e.message));
  s.on("disconnect", (r) => window.__log.push("disconnect:" + r));
  "armed"
"""})
time.sleep(4)
c.call("Runtime.evaluate", {"expression": 'window.__s.emit("add", 1, 2); "sent"'})
time.sleep(2)
out = c.call("Runtime.evaluate", {"expression": "JSON.stringify(window.__log)", "returnByValue": True})["result"]["value"]
for line in json.loads(out):
    print("client:", line)
print("connected:", c.call("Runtime.evaluate", {"expression": "window.__s.connected", "returnByValue": True})["result"].get("value"))

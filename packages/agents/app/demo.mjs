import { chromium } from "playwright";

const CONSOLE = "http://51.91.124.105:5173";

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1400, height: 820 },
  recordVideo: { dir: "/tmp/demo", size: { width: 1400, height: 820 } },
  baseURL: CONSOLE,
});
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));

let threadId = "";
p.on("response", async (r) => {
  try {
    if (new URL(r.url()).pathname !== "/api/threads" || r.request().method() !== "POST") return;
    threadId = (await r.json()).id;
  } catch { /* not it */ }
});

await p.goto(CONSOLE, { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

const composer = p.locator('agent-console nr-chatbot [contenteditable="true"]').first();
await composer.click();
await composer.type("build me a small dashboard", { delay: 35 });
await composer.press("Enter");
for (let i = 0; i < 80 && threadId === ""; i++) await p.waitForTimeout(250);
await p.waitForTimeout(1500);

const index = [
  '<!doctype html><meta charset="utf-8"><title>Dashboard</title>',
  '<link rel="stylesheet" href="css/main.css">',
  '<h1>Quarterly dashboard</h1>',
  '<div class="grid">',
  '  <div class="card"><span class="k">Revenue</span><b id="rev">-</b></div>',
  '  <div class="card"><span class="k">Customers</span><b id="cus">-</b></div>',
  '  <div class="card"><span class="k">Churn</span><b id="chu">-</b></div>',
  '</div>',
  '<div class="bars"><div data-h="42%"></div><div data-h="61%"></div><div data-h="78%"></div><div data-h="94%"></div></div>',
  '<p class="src">Three files: index.html, css/main.css, js/app.js</p>',
  '<script src="js/app.js"></script>',
].join("\n");

const css = [
  ':root{--ink:#17171A;--muted:#6B6B76;--line:#E7E7EC;--teal:#0F766E}',
  'body{font:14px system-ui;margin:0;padding:26px;color:var(--ink);background:#fff}',
  'h1{font-size:19px;margin:0 0 18px;letter-spacing:-.01em}',
  '.grid{display:flex;gap:12px;margin-bottom:22px}',
  '.card{flex:1;border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:6px}',
  '.k{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}',
  '.card b{font-size:22px;font-variant-numeric:tabular-nums}',
  '.bars{display:flex;align-items:flex-end;gap:10px;height:150px;border-bottom:1px solid var(--line);padding-bottom:2px}',
  '.bars div{flex:1;background:var(--teal);border-radius:4px 4px 0 0;height:0}',
  '.src{color:var(--muted);font-size:12px;margin-top:14px}',
].join("\n");

const js = [
  'const set = (id, v) => document.getElementById(id).textContent = v;',
  'set("rev", "$1.24M"); set("cus", "3,180"); set("chu", "2.1%");',
  'document.querySelectorAll(".bars div").forEach((d, i) => {',
  '  setTimeout(() => {',
  '    d.style.transition = "height .6s ease-out";',
  '    d.style.height = d.dataset.h;',
  '  }, 200 + 140 * i);',
  '});',
].join("\n");

for (const f of [
  { path: "/index.html", title: "Quarterly dashboard", content: index, note: "first cut" },
  { path: "/css/main.css", title: "", content: css, note: "" },
  { path: "/js/app.js", title: "", content: js, note: "" },
]) {
  const r = await p.request.post(`${CONSOLE}/api/threads/${threadId}/artifacts`, { data: f });
  console.log(f.path, r.status());
}

await p.locator('agent-console button[title="Artifacts"]').click();
await p.waitForTimeout(1600);
await p.locator("agent-console artifact-panel").getByText("Quarterly", { exact: false }).first().click();
await p.waitForTimeout(4500);
await p.screenshot({ path: "/tmp/multifile.png" });

const src = await p.locator("agent-console artifact-panel iframe").getAttribute("src");
console.log("iframe src:", src);
await p.waitForTimeout(1200);
await ctx.close();
await b.close();
console.log("done");

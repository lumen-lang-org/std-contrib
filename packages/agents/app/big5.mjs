import { chromium } from "@playwright/test";
try {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto("http://127.0.0.1:5273/", { timeout: 30000 });
  await p.waitForTimeout(6000);
  await p.reload(); await p.waitForTimeout(4000);
  const g = await p.evaluate(() => {
    const deep = (root, x) => { const h = root.querySelector(x); if (h) return h;
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const r = deep(el.shadowRoot, x); if (r) return r; } return null; };
    const t = deep(document, ".empty-state__content");
    return t ? { size: getComputedStyle(t).fontSize, top: Math.round(t.getBoundingClientRect().top) } : "no title node";
  });
  console.log("title:", JSON.stringify(g));
  await p.screenshot({ path: "/tmp/claude-1000/-home-ubuntu-projects/d7a464b1-451d-46f9-a4ea-42eb8304004d/scratchpad/joule-big.png" });
  await b.close();
} catch (e) { console.log("FAILED:", e.message.slice(0, 200)); }

// Spike probe. Loads the lumenjs-served console in a real browser and reports
// the two things the spike is actually asking about:
//   1. did the LumenUI bundle set load without `define() has already been
//      used`, and did <agent-console> build a real subtree
//   2. does a page socket push land on the page
//
// Not a test suite — phase 5's e2e is. This exists so the spike verdict is
// evidence rather than an impression.
import { chromium } from '/home/ubuntu/projects/std-contrib/packages/agents/app/node_modules/playwright/index.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5273/';
const SHOT = process.argv[3] ?? '/tmp/spike.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const consoleErrors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const dom = await page.evaluate(() => {
  const el = document.querySelector('agent-console')
    ?? document.querySelector('page-index')?.shadowRoot?.querySelector('agent-console');
  const sr = el && el.shadowRoot;
  const deep = (root, sel) => root ? root.querySelectorAll(sel).length : 0;
  return {
    found: !!el,
    shadowChildren: sr ? sr.children.length : 0,
    shadowHtmlLength: sr ? sr.innerHTML.length : 0,
    box: el ? { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height } : null,
    sidebar: deep(sr, 'console-sidebar'),
    chatbot: deep(sr, 'nr-chatbot'),
    // Every custom element the console asked the browser to define.
    definedTags: ['agent-console', 'console-sidebar', 'workspace-panel', 'artifact-panel',
      'console-settings', 'knowledge-page', 'agent-canvas', 'nr-chatbot', 'nr-icon',
      'nr-button', 'nr-input', 'nr-select', 'nr-checkbox', 'nr-textarea', 'nr-overlay',
      'nr-code-editor', 'nr-dropdown', 'nr-modal']
      .filter((t) => !!customElements.get(t)),
    probe: document.querySelector('page-index')?.shadowRoot
      ?.querySelector('[data-testid="socket-probe"]')?.textContent?.trim(),
  };
});

// Watch the socket probe change — a single non-empty read could be a loader.
const first = dom.probe;
await page.waitForTimeout(2500);
const second = await page.evaluate(() => document.querySelector('page-index')?.shadowRoot
  ?.querySelector('[data-testid="socket-probe"]')?.textContent?.trim());

await page.screenshot({ path: SHOT, fullPage: false });
await browser.close();

console.log(JSON.stringify({
  dom,
  socket: { first, second, changed: first !== second },
  pageErrors: errors,
  consoleErrors: consoleErrors.slice(0, 25),
  defineCollision: [...errors, ...consoleErrors].some((t) => /has already been used/.test(t)),
}, null, 2));

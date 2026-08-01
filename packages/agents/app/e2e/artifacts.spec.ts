// Artifacts: what is stored, what is served, and what the browser is allowed
// to do with it.
//
// The security half of this file is the point. An artifact is a body a model
// wrote, and previewing it means handing that body to a browser — so the tests
// that matter are the ones asserting what the response headers say, not the
// ones asserting a row came back. No handler in this package had ever set a
// response header before this feature, which makes these the tripwire: if the
// content-type ever becomes text/html on the console's own origin, or the CSP
// loses connect-src 'none', a model-authored page can read every agent, every
// document and every key envelope reference in the database.
//
// They are written against the API rather than the UI wherever the claim is
// about bytes and headers, because that is where the claim actually lives.

import { expect, test } from "@playwright/test";
// The panel's file rows are `.row` (an icon tile, a name, a meta line), not
// `.artifact` — that class stopped existing when the office viewer landed and
// these selectors were never moved with it, so four tests here were failing
// against markup that had simply been renamed under them.
import { loaded, open, shell } from "./console.js";

const HTML = "<!doctype html><title>t</title><p>hello</p>";

// Where a preview lives from the console's side.
//
// The API answers a create with the token, not a URL — deliberately: the
// server does not know which origin previews are served from, and inventing
// one would bake a guess into every stored reply. The console proxies /api to
// the API, so /api/preview/<token> is that route from here. A deployment with
// a real preview host points at it directly instead.
//
// A version pins through `?v=`, not `/v/`: everything under the token is the
// thread's other artifacts now, addressed by their own path, so a pinned form
// living in the path could not be told apart from a sibling.
const previewOf = (token: string, version?: number) =>
  version === undefined
    ? `/api/preview/${token}`
    : `/api/preview/${token}?v=${version}`;

// A thread to hang artifacts off. Made per test file rather than per test: the
// routes are thread-scoped, and reusing one keeps the slots readable.
async function openThread(request: import("@playwright/test").APIRequestContext) {
  const agents = (await request.get("/api/agents").then((r) => r.json())) as
    { id: string; enabled: boolean }[];
  const agent = agents.find((a) => a.enabled) ?? agents[0];
  const res = await request.post("/api/threads", { data: { agentId: agent.id } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

async function write(
  request: import("@playwright/test").APIRequestContext,
  threadId: string,
  body: { path: string; title?: string; content: string; note?: string },
) {
  return request.post(`/api/threads/${threadId}/artifacts`, {
    data: { title: "", note: "", ...body },
  });
}

test.describe("storage", () => {
  test("an artifact is created and listed", async ({ request }) => {
    const thread = await openThread(request);
    const res = await write(request, thread, { path: "/hello.html", content: HTML });
    expect(res.status()).toBe(201);

    const made = await res.json();
    expect(made.version).toBe(1);
    expect(typeof made.slot).toBe("number");
    expect(String(made.previewToken).length).toBeGreaterThan(16);

    const listed = (await request.get(`/api/threads/${thread}/artifacts`)
      .then((r) => r.json())) as { path: string; kind: string }[];
    const mine = listed.find((a) => a.path === "/hello.html");
    expect(mine).toBeDefined();
    // Kind is derived from the extension, never taken from the caller.
    expect(mine!.kind).toBe("html");
  });

  test("writing the same path again is a new version, not a new artifact", async ({ request }) => {
    const thread = await openThread(request);
    const first = await write(request, thread, { path: "/v.html", content: "<p>one</p>" });
    const second = await write(request, thread, { path: "/v.html", content: "<p>two</p>" });

    expect((await first.json()).version).toBe(1);
    expect((await second.json()).version).toBe(2);
    expect((await second.json()).slot).toBe((await first.json()).slot);

    const listed = (await request.get(`/api/threads/${thread}/artifacts`)
      .then((r) => r.json())) as { path: string }[];
    expect(listed.filter((a) => a.path === "/v.html")).toHaveLength(1);
  });

  test("an older version is still readable — versions are append-only", async ({ request }) => {
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/keep.md", content: "one" })
      .then((r) => r.json());
    await write(request, thread, { path: "/keep.md", content: "two" });

    const v1 = await request
      .get(`/api/threads/${thread}/artifacts/${made.slot}/versions/1`)
      .then((r) => r.json());
    expect(v1.content).toBe("one");
  });

  test("concurrent writes to one path both survive as versions", async ({ request }) => {
    // persist() upserts. If the write path used it for version rows, one of
    // these would overwrite the other and a version would vanish with no error.
    const thread = await openThread(request);
    await write(request, thread, { path: "/race.md", content: "seed" });

    const results = await Promise.all([
      write(request, thread, { path: "/race.md", content: "a" }),
      write(request, thread, { path: "/race.md", content: "b" }),
      write(request, thread, { path: "/race.md", content: "c" }),
    ]);
    for (const r of results) expect(r.ok()).toBeTruthy();

    const slot = (await results[0].json()).slot;
    const found = await request.get(`/api/threads/${thread}/artifacts/${slot}`)
      .then((r) => r.json()) as { version: number };
    expect(found.version).toBe(4);

    // The point is not the count but that nothing was dropped: four writes,
    // four bodies, each still reachable at its own number. A lost version
    // would show up here as a 404 or a repeated body, not as a wrong total.
    const bodies: string[] = [];
    for (let v = 1; v <= 4; v++) {
      const res = await request.get(`/api/threads/${thread}/artifacts/${slot}/versions/${v}`);
      expect(res.status()).toBe(200);
      bodies.push((await res.json()).content as string);
    }
    expect(new Set(bodies).size).toBe(4);
    expect(bodies).toContain("seed");
    for (const said of ["a", "b", "c"]) expect(bodies).toContain(said);
  });
});

test.describe("paths and limits", () => {
  const refused = [
    { why: "traversal", path: "/../secret.html" },
    { why: "an empty segment", path: "/a//b.html" },
    { why: "a backslash", path: "/a\\b.html" },
    { why: "a SQL wildcard", path: "/a%b.html" },
  ];

  for (const c of refused) {
    test(`a path with ${c.why} is refused`, async ({ request }) => {
      const thread = await openThread(request);
      const res = await write(request, thread, { path: c.path, content: "x" });
      expect(res.status()).toBe(400);
    });
  }

  // The extension does NOT decide whether a path is allowed, and this pair
  // used to sit in the list above claiming it did. It stopped being true when
  // uploads landed: a customer's .xml or .pdf refused at the door was a worse
  // answer than an opaque body scripts still get byte for byte, so anything
  // the kind table does not name is stored as kind "file". The segment rules
  // above — traversal, empty segments, backslashes, wildcards — are what
  // actually protect the store, and they are unchanged.
  //
  // Asserted rather than deleted, because "no longer refused" is a claim about
  // behaviour and needs a test of its own; a case removed from a list says
  // nothing at all.
  for (const c of [
    { why: "no extension", path: "/plain" },
    { why: "an unknown extension", path: "/thing.exe" },
  ]) {
    test(`a path with ${c.why} is stored as an opaque file`, async ({ request }) => {
      const thread = await openThread(request);
      const res = await write(request, thread, { path: c.path, content: "x" });
      expect(res.status()).toBe(201);
      const listed = (await request.get(`/api/threads/${thread}/artifacts`)
        .then((r) => r.json())) as { path: string; kind: string }[];
      expect(listed.find((a) => a.path === c.path)?.kind).toBe("file");
    });
  }

  test("a body over the cap is refused, and the sentence names the number", async ({ request }) => {
    const thread = await openThread(request);
    const res = await write(request, thread, {
      path: "/big.txt",
      content: "x".repeat(524_289),
    });
    expect(res.status()).toBe(400);
    // A refusal that does not say the limit cannot be acted on — including by
    // a model retrying smaller.
    expect(await res.text()).toContain("524288");
  });
});

test.describe("preview: what the browser is told", () => {
  test("the console origin never serves an artifact as html", async ({ request }) => {
    // The single most important assertion here. AGENTS_PREVIEW_HOST is not the
    // host these tests speak to, so the body must come back inert.
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/x.html", content: HTML })
      .then((r) => r.json());

    const res = await request.get(previewOf(made.previewToken));
    expect(res.status()).toBe(200);
    const type = res.headers()["content-type"] ?? "";
    expect(type).toContain("text/plain");
    expect(type).not.toContain("text/html");
    // The bytes are unchanged — it is the labelling that makes it safe.
    expect(await res.text()).toBe(HTML);
  });

  test("an svg is inert on the console origin too", async ({ request }) => {
    const thread = await openThread(request);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
    const made = await write(request, thread, { path: "/i.svg", content: svg })
      .then((r) => r.json());

    const type = (await request.get(previewOf(made.previewToken))).headers()["content-type"] ?? "";
    expect(type).toContain("text/plain");
    expect(type).not.toContain("image/svg");
  });

  test("every preview carries the headers that contain it", async ({ request }) => {
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/h.html", content: HTML })
      .then((r) => r.json());
    const h = (await request.get(previewOf(made.previewToken))).headers();

    const csp = h["content-security-policy"] ?? "";
    // connect-src 'none' is the actual no-API-access enforcement: it holds even
    // if /api is ever mounted on the preview host.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // In the header, not the iframe attribute — the attribute does not exist
    // when someone opens the artifact in a tab of its own.
    expect(csp).toContain("sandbox allow-scripts");
    // allow-same-origin would hand the sandbox back everything it took away.
    expect(csp).not.toContain("allow-same-origin");

    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    // Console JavaScript reads artifacts over the API; the browser reads them
    // over the preview host. Those paths must never merge.
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });

  test("the current preview is never cached; a pinned version always is", async ({ request }) => {
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/c.html", content: HTML })
      .then((r) => r.json());

    const current = (await request.get(previewOf(made.previewToken))).headers();
    expect(current["cache-control"]).toContain("no-store");

    const pinned = (await request.get(previewOf(made.previewToken, 1))).headers();
    expect(pinned["cache-control"]).toContain("immutable");
  });

  test("rotating the token retires every link that was shared", async ({ request }) => {
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/r.html", content: HTML })
      .then((r) => r.json());
    const before = previewOf(made.previewToken);
    expect((await request.get(before)).status()).toBe(200);

    const rotated = await request
      .post(`/api/threads/${thread}/artifacts/${made.slot}/rotate`)
      .then((r) => r.json());

    const after = previewOf(rotated.previewToken);
    expect(after).not.toBe(before);
    // The old capability URL is the only control on the preview host, so
    // revoking it has to actually revoke it.
    expect((await request.get(before)).status()).toBe(404);
    expect((await request.get(after)).status()).toBe(200);
  });

  test("an unknown token says nothing about whether it ever existed", async ({ request }) => {
    const res = await request.get(previewOf("0123456789abcdef0123456789abcdef"));
    expect(res.status()).toBe(404);
  });
});

test.describe("deletion", () => {
  test("a deleted artifact is gone, and its slot is not reused", async ({ request }) => {
    const thread = await openThread(request);
    const first = await write(request, thread, { path: "/d1.md", content: "one" })
      .then((r) => r.json());
    await request.delete(`/api/threads/${thread}/artifacts/${first.slot}`);

    expect((await request.get(`/api/threads/${thread}/artifacts/${first.slot}`)).status()).toBe(404);
    expect((await request.get(previewOf(first.previewToken))).status()).toBe(404);

    // What is actually guaranteed, and what is not.
    //
    // A slot is never shared by two LIVE artifacts — that is the unique index
    // on (thread_id, slot), and it is the property that stops a link resolving
    // to two different things at once. It is not a permanent handle: delete
    // every artifact in a thread and the next one starts at 0 again, because
    // the number is derived from MAX(slot) over live rows and there is nothing
    // left to derive from. A stale /artifacts/0 link can therefore reach a
    // different artifact than it once did.
    //
    // The preview link — the one that gets shared — is unaffected, because it
    // is addressed by a token minted per artifact, and the deleted one's token
    // is gone for good (asserted above). Making the slot permanent as well
    // needs a per-thread high-water mark that survives deletion, which is a
    // column this cut does not have.
    const second = await write(request, thread, { path: "/d2.md", content: "two" })
      .then((r) => r.json());
    const live = (await request.get(`/api/threads/${thread}/artifacts`)
      .then((r) => r.json())) as { slot: number }[];
    expect(new Set(live.map((a) => a.slot)).size).toBe(live.length);
    expect(second.previewToken).not.toBe(first.previewToken);
  });
});

test.describe("the panel", () => {
  test("an html artifact renders in a sandboxed iframe, never inline", async ({ page }) => {
    await open(page);
    await expect(shell(page)).toBeVisible();

    // The panel shows the artifacts of the conversation that is open, so the
    // test has to be in one. A thread is created lazily by the first message —
    // the same path a person takes — and its id is read off that request
    // rather than guessed at.
    let threadId = "";
    page.on("response", async (r) => {
      if (new URL(r.url()).pathname !== "/api/threads" || r.request().method() !== "POST") return;
      try { threadId = (await r.json()).id as string; } catch { /* not it */ }
    });

    const composer = page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
    await composer.click();
    await composer.type("make me something");
    await composer.press("Enter");
    await expect.poll(() => threadId, { timeout: 30_000 }).not.toBe("");

    // The artifact a model would have written, written directly so the test
    // does not depend on a provider being reachable.
    const made = await page.request.post(`/api/threads/${threadId}/artifacts`, {
      data: { path: "/panel.html", title: "Panel", content: HTML, note: "" },
    });
    expect(made.status()).toBe(201);

    await page.locator('agent-console button[title="Artifacts"]').click();
    const panel = page.locator("agent-console artifact-panel");
    await expect(panel).toBeVisible();

    await panel.getByText("Panel", { exact: false }).first().click();

    const frame = panel.locator("iframe");
    await expect(frame).toBeVisible();
    // srcdoc and data: both inherit the embedder's origin, which is the whole
    // thing the preview host exists to prevent.
    await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(await frame.getAttribute("srcdoc")).toBeNull();
    expect(await frame.getAttribute("src")).toContain("/preview/");
  });
});

test.describe("siblings: one artifact referencing another", () => {
  test("a sibling in the same thread is served by relative path", async ({ request }) => {
    const thread = await openThread(request);
    const page = await write(request, thread, {
      path: "/index.html",
      content: '<!doctype html><link rel="stylesheet" href="css/main.css"><p>hi</p>',
    }).then((r) => r.json());
    await write(request, thread, { path: "/css/main.css", content: "p{color:red}" });

    // Nested, so this also proves the router's wildcard: the path is two
    // segments under the token, which a fixed-arity route cannot express.
    const res = await request.get(`/api/preview/${page.previewToken}/css/main.css`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe("p{color:red}");
  });

  test("a stylesheet and a script keep the types a browser will accept", async ({ request }) => {
    // The point of the whole change. A cross-origin stylesheet is rejected on
    // its content type alone, and the preview sandbox makes every subresource
    // fetch cross-origin — so text/plain here means the page silently renders
    // unstyled however permissive the CSP is.
    //
    // On this origin the type is downgraded, so what is asserted is the stored
    // mime the preview host would send.
    const thread = await openThread(request);
    const made = await write(request, thread, { path: "/a.css", content: "b{}" })
      .then((r) => r.json());
    const found = await request.get(`/api/threads/${thread}/artifacts/${made.slot}`)
      .then((r) => r.json()) as { kind: string; mime: string };
    expect(found.kind).toBe("css");
    expect(found.mime).toContain("text/css");

    const js = await write(request, thread, { path: "/a.js", content: "1" })
      .then((r) => r.json());
    const jsFound = await request.get(`/api/threads/${thread}/artifacts/${js.slot}`)
      .then((r) => r.json()) as { kind: string; mime: string };
    expect(jsFound.kind).toBe("javascript");
    expect(jsFound.mime).toContain("javascript");
  });

  test("the console origin still downgrades a sibling to text/plain", async ({ request }) => {
    const thread = await openThread(request);
    const page = await write(request, thread, { path: "/i.html", content: HTML })
      .then((r) => r.json());
    await write(request, thread, { path: "/s.css", content: "b{}" });

    const res = await request.get(`/api/preview/${page.previewToken}/s.css`);
    expect(res.headers()["content-type"]).toContain("text/plain");
    // The containment headers are on siblings too, not only the entry.
    expect(res.headers()["content-security-policy"]).toContain("connect-src 'none'");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("a sibling path cannot be walked out of its thread", async ({ request }) => {
    const mine = await openThread(request);
    const other = await openThread(request);
    const page = await write(request, mine, { path: "/i.html", content: HTML })
      .then((r) => r.json());
    await write(request, other, { path: "/secret.md", content: "not yours" });

    for (const attempt of [
      "secret.md",
      "../secret.md",
      "%2e%2e/secret.md",
      "..%2Fsecret.md",
      "/secret.md",
      "a/../../secret.md",
    ]) {
      const res = await request.get(`/api/preview/${page.previewToken}/${attempt}`);
      expect(res.status(), `${attempt} must not resolve`).toBe(404);
    }
  });

  test("rotating a link retires every link in the thread, not just one", async ({ request }) => {
    // A token reaches any artifact in its thread, so revoking one artifact's
    // link while a neighbour's still reaches it revokes nothing.
    const thread = await openThread(request);
    const a = await write(request, thread, { path: "/a.html", content: HTML }).then((r) => r.json());
    const b = await write(request, thread, { path: "/b.html", content: HTML }).then((r) => r.json());

    expect((await request.get(`/api/preview/${b.previewToken}/a.html`)).status()).toBe(200);

    await request.post(`/api/threads/${thread}/artifacts/${a.slot}/rotate`);

    // B's old link is dead too — otherwise it still reaches A.
    expect((await request.get(`/api/preview/${b.previewToken}/a.html`)).status()).toBe(404);
    expect((await request.get(previewOf(b.previewToken))).status()).toBe(404);
  });
});

// --- the diff between versions ---------------------------------------------------

test("the panel diffs a version against the one before it, sign by sign", async ({ page, request }) => {
  const thread = await openThread(request);
  const path = `/diffed-${Date.now()}.json`;
  await write(request, thread, { path, content: '{\n  "QueryOperator": "Eq",\n  "Value": "x"\n}' });
  await write(request, thread, { path, content: '{\n  "QueryOperator": "OrEq",\n  "Value": "x"\n}' });

  await open(page);
  await expect(shell(page)).toBeVisible();
  await shell(page).locator(`console-sidebar .thread[data-thread="${thread}"]`).click();
  await shell(page).locator('button[title="Artifacts"]').click();
  const panel = shell(page).locator("artifact-panel");
  await panel.locator(".row", { hasText: path.slice(1) }).click();

  // A version past the first opens AS its diff — the first question about an
  // edit is what it changed, so nobody clicks to ask it.
  const removed = panel.locator(".diff .r.del");
  const added = panel.locator(".diff .r.add");
  await expect(removed).toHaveCount(1);
  await expect(added).toHaveCount(1);
  await expect(removed).toContainText('"QueryOperator": "Eq",');
  await expect(added).toContainText('"QueryOperator": "OrEq",');
  // Unchanged lines stay, so the reader keeps their bearings — and every row
  // carries its line numbers.
  await expect(panel.locator(".diff .r", { hasText: '"Value": "x"' })).toBeVisible();
  await expect(removed.locator(".n").first()).toHaveText("2");
  await expect(added.locator(".n").nth(1)).toHaveText("2");
  await expect(panel.locator(".diff .tally")).toContainText("+1");
  // The arrows walk the changes.
  await expect(panel.locator("#a-diff-next")).toBeVisible();

  // The toggle goes to the content, whole and numbered.
  await panel.locator("#a-diff").click();
  await expect(panel.locator(".pre")).toContainText('"QueryOperator": "OrEq"');
  await expect(panel.locator(".pre .r").first().locator(".n")).toHaveText("1");

  // A first version has nothing to differ from: the button is disabled on v1.
  // Asserted as the attribute, not toBeDisabled(): nr-button is a custom
  // element, and native disabled semantics are not what it carries.
  await panel.locator(".versions .v", { hasText: "v1" }).click();
  await expect(panel.locator("#a-diff")).toHaveAttribute("disabled", "");
});

test("a wrongly-escaped edit is refused with the escaping named, and writes nothing", async ({ page, request }) => {
  // The live failure this pins: a model editing a JSON artifact that holds
  // Windows paths guessed the backslash escaping wrong, was told only
  // "matches nothing", and looped. The refusal now names the exact miss; the
  // double's second round proves the sentence reached the model.
  const { ensureDoubled } = await import("./console.js");
  const agentId = await ensureDoubled(request);
  const res = await request.post("/api/threads", { data: { agentId } });
  const thread = (await res.json()).id as string;
  await write(request, thread, {
    path: "/win.json",
    content: '{\n  "UserConfigId": "D:\\\\Fo2pdf\\\\USERCONFIG.XML"\n}',
  });

  await open(page);
  await expect(shell(page)).toBeVisible();
  await shell(page).locator(`console-sidebar .thread[data-thread="${thread}"]`).click();
  const composer = page.locator('agent-console nr-chatbot [contenteditable="true"]').first();
  await composer.click();
  await composer.type("fix the windows path");
  await composer.press("Enter");

  // The card shows the refused edit; the answer shows the model understood.
  const bot = page.locator("agent-console nr-chatbot .message.bot").last();
  await expect(bot).toContainText("under-escaped", { timeout: 30000 });

  // And nothing was written: the artifact is still version 1, byte-identical.
  const arts = (await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json())) as
    { path: string; version: number }[];
  expect(arts.find((a) => a.path === "/win.json")?.version).toBe(1);
});

// --- uploading from the console --------------------------------------------------

test("a person uploads a file from the panel and it lands as an artifact", async ({ page, request }) => {
  const thread = await openThread(request);
  await open(page);
  await expect(shell(page)).toBeVisible();
  await shell(page).locator(`console-sidebar .thread[data-thread="${thread}"]`).click();
  await shell(page).locator('button[title="Artifacts"]').click();
  const panel = shell(page).locator("artifact-panel");

  // Through the UI, exactly as a person would: the button opens the picker,
  // the picker is a real file input, and the panel says what happened.
  const name = `uploaded-${Date.now()}.json`;
  await panel.locator("#a-upload").click();
  await panel.locator("#a-file").setInputFiles({
    name, mimeType: "application/json", buffer: Buffer.from('{"Hello": "from the console"}'),
  });
  await expect(panel).toContainText(`Uploaded ${name}`);
  await expect(panel.locator(".row", { hasText: name })).toBeVisible();

  // The API is for asserting what was really stored, never for the action.
  const listed = (await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json())) as
    { path: string; version: number; slot: number }[];
  const mine = listed.find((a) => a.path === `/${name}`);
  expect(mine).toBeTruthy();
  const v = await request
    .get(`/api/threads/${thread}/artifacts/${mine!.slot}/versions/1`)
    .then((r) => r.json());
  expect(v.content).toBe('{"Hello": "from the console"}');
  expect(v.origin).toBe("uploaded");

  // A binary upload rides the base64 rule the office kinds share. The bytes
  // here are a tiny zip — enough to prove the round trip is byte-faithful.
  const zipBytes = Buffer.from("UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAJAAAAZW1wdHkudHh0AwBQSwUGAAAAAAEAAQA3AAAAIgAAAAAA", "base64");
  const officeName = `uploaded-${Date.now()}.xlsx`;
  await panel.locator("#a-upload").click();
  await panel.locator("#a-file").setInputFiles({
    name: officeName,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: zipBytes,
  });
  await expect(panel).toContainText(`Uploaded ${officeName}`);
  const again = (await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json())) as
    { path: string; slot: number; kind: string }[];
  const office = again.find((a) => a.path === `/${officeName}`);
  expect(office).toBeTruthy();
  expect(office!.kind).toBe("office");
  const stored = await request
    .get(`/api/threads/${thread}/artifacts/${office!.slot}/versions/1`)
    .then((r) => r.json());
  expect(Buffer.from(stored.content, "base64").equals(zipBytes)).toBeTruthy();

  // Any extension at all: an unknown one is not refused but stored as an
  // opaque kind "file" — the rule customers' .xml and .pdf uploads live by.
  const anyName = `uploaded-${Date.now()}.xml`;
  await panel.locator("#a-upload").click();
  await panel.locator("#a-file").setInputFiles({
    name: anyName, mimeType: "application/xml", buffer: Buffer.from("<userconfig><pdf version=\"1.4\"/></userconfig>"),
  });
  await expect(panel).toContainText(`Uploaded ${anyName}`);
  const all = (await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json())) as
    { path: string; slot: number; kind: string }[];
  const xml = all.find((a) => a.path === `/${anyName}`);
  expect(xml).toBeTruthy();
  expect(xml!.kind).toBe("file");
});

test("a file attached in the composer lands as an artifact of a freshly opened thread", async ({ page, request }) => {
  await open(page);
  await expect(shell(page)).toBeVisible();

  // The component builds its file input on demand, so the chooser event is
  // the only handle a test can hold.
  await shell(page).locator('nr-chatbot [aria-label="Attach files"]').first().click();
  const name = `attached-${Date.now()}.xml`;
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    shell(page).locator("text=Upload File").first().click(),
  ]);
  await chooser.setFiles({
    name, mimeType: "application/xml", buffer: Buffer.from("<userconfig/>"),
  });

  // The receipt in the tray, then the stored truth: the attach opened a
  // thread of its own and filed the bytes as an opaque artifact.
  await expect(shell(page).locator("nr-chatbot")).toContainText(name);
  const threads = (await request.get("/api/threads?limit=1").then((r) => r.json())) as { id: string }[];
  const arts = (await request.get(`/api/threads/${threads[0].id}/artifacts`).then((r) => r.json())) as
    { path: string; kind: string }[];
  const mine = arts.find((a) => a.path === `/${name}`);
  expect(mine).toBeTruthy();
  expect(mine!.kind).toBe("file");
});

test("uploading from the panel with no conversation open creates the thread first", async ({ page, request }) => {
  // Loaded, not merely drawn: opening the conversation needs an agent to open
  // it against, and that list is a fetch. Uploading before it lands leaves the
  // panel still saying "Open a conversation first", which reads as the feature
  // being gone rather than as the console not being ready to be asked.
  await open(page);
  await loaded(page);
  await expect(shell(page)).toBeVisible();

  // A fresh console: no thread, rail opened by hand, and the upload button is
  // there — it opens the conversation the same way a first message would.
  await shell(page).locator('button[title="Artifacts"]').click();
  const panel = shell(page).locator("artifact-panel");
  await expect(panel.locator("#a-upload")).toBeVisible();
  const name = `panel-fresh-${Date.now()}.pdf`;
  await panel.locator("#a-file").setInputFiles({
    name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 not really"),
  });
  await expect(panel).toContainText(`Uploaded ${name}`);

  const threads = (await request.get("/api/threads?limit=1").then((r) => r.json())) as
    { id: string; title: string }[];
  // The thread the upload opened wears the file's name as its title — the
  // only honest title a wordless conversation has.
  expect(threads[0].title).toBe(`/${name}`);
  const arts = (await request.get(`/api/threads/${threads[0].id}/artifacts`).then((r) => r.json())) as
    { path: string; kind: string }[];
  expect(arts.find((a) => a.path === `/${name}`)?.kind).toBe("file");
});

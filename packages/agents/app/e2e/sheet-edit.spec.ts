// Editing a workbook's cells in the panel.
//
// The claim under test is narrow and strong: typing into a cell and saving
// produces a NEW artifact version whose changed cell changed — and whose
// charts, styles and every other part came through untouched, because the
// save patches the one worksheet inside the original zip rather than
// rewriting the file through a library that drops what it does not model.
//
// The fidelity assertion reads the zip directly: entry names are stored
// verbatim in a zip's central directory, so "the chart survived" is a
// substring check on the decoded bytes, no unzip library required.

import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { open, shell } from "./console.js";

test("a cell edit saves as a new version and the charts survive it", async ({ page, request }) => {
  // The savings template ships a chart — the exact thing a lossy save loses.
  const tpl = (await request.get("/api/templates/tpl-sheet-savings/files").then((r) => r.json())) as
    { body: string }[];
  test.skip(tpl.length === 0, "the savings template is not on this deployment");
  const before = tpl[0].body;
  expect(Buffer.from(before, "base64").includes("xl/charts/chart1.xml")).toBe(true);

  // A real agent, because the door demands one: agentId "" is refused, and a
  // refused create quietly poisons every later step's URL.
  const agents = (await request.get("/api/agents").then((r) => r.json())) as
    { id: string; enabled: boolean; isDefault: boolean }[];
  const agent = agents.find((a) => a.isDefault && a.enabled) ?? agents.find((a) => a.enabled);
  expect(agent, "no enabled agent to open a thread against").toBeTruthy();
  const made = await request.post("/api/threads", { data: { agentId: agent!.id } });
  expect(made.ok(), "could not open a thread").toBeTruthy();
  const thread = (await made.json()).id as string;
  await request.post(`/api/threads/${thread}/artifacts`, { data: {
    path: "/savings.xlsx", title: "Savings", content: before, note: "seeded by sheet-edit.spec",
  } });

  // Straight to the conversation's own address: an empty seeded thread has no
  // messages, and the rail's list is entitled not to carry it yet.
  await open(page, `/c/${thread}`);
  await shell(page).locator('button[title="Artifacts"]').click();
  const panel = shell(page).locator("artifact-panel");
  // By the row's title attribute: the visible label is the artifact's TITLE
  // ("Savings"), and filtering on text raced the meta line's wording.
  await panel.locator('.row[title="/savings.xlsx"]').click();

  // B3 holds the starting balance (1,000.00). Type a new number over it.
  const cell = panel.locator("td[data-ref=\"B3\"]");
  await expect(cell).toBeVisible();
  await cell.click();
  await cell.fill("2500");
  await expect(panel.locator(".sheet-savebar")).toContainText("1 cell changed");
  await panel.locator(".sheet-save").click();

  // A new version, through the same door an upload uses.
  await expect
    .poll(async () => (await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json()))
      .find((a: { path: string }) => a.path === "/savings.xlsx")?.version)
    .toBe(2);
  const v2 = await request.get(`/api/threads/${thread}/artifacts/` +
    ((await request.get(`/api/threads/${thread}/artifacts`).then((r) => r.json()))
      .find((a: { path: string }) => a.path === "/savings.xlsx").slot) + "/versions/2")
    .then((r) => r.json());
  expect(v2.origin).toBe("uploaded");
  expect(v2.note).toBe("edited in the console");

  // Opened as the zip it is: entry NAMES sit uncompressed in the central
  // directory, but cell values live inside DEFLATE — a substring check on the
  // raw bytes reads the manifest, not the sheet.
  const zip = await JSZip.loadAsync(Buffer.from(v2.content as string, "base64"));
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  // The edit landed, as a number in the cell…
  expect(sheet).toContain('r="B3"');
  expect(sheet).toContain(">2500<");
  // …and nothing else was lost: the chart and the styles are still whole,
  // byte-identical to the original's parts.
  expect(zip.file("xl/charts/chart1.xml")).not.toBeNull();
  const beforeZip = await JSZip.loadAsync(Buffer.from(before, "base64"));
  expect(await zip.file("xl/styles.xml")!.async("string"))
    .toBe(await beforeZip.file("xl/styles.xml")!.async("string"));
  expect(await zip.file("xl/charts/chart1.xml")!.async("string"))
    .toBe(await beforeZip.file("xl/charts/chart1.xml")!.async("string"));
  expect(v2.content).not.toBe(before);

  // And the panel now renders v2 with the typed value in the cell.
  await expect(panel.locator("td[data-ref=\"B3\"]")).toHaveText(/2500|2,500/);
});

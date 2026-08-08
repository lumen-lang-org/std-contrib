// Workflows through a conversation: what the tools build, and what they
// refuse.
//
//   cd packages/agents && ../cron/build.sh && lumen test workflow-tools.test.ts
//
// The chain builder is the piece a person never sees working — a model says
// "search, then summarise" and a graph exists with positions, edges and an
// END. So the tests read the graph back and walk its shape, and the refusals
// get the same attention task-tools.test.ts gives them: a guest, a stranger's
// row, a branch a splice must not guess about.

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, dropTable, listWhere, persist } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { WfGraph, refuse as refuseGraph, startOf } from "../workflow/workflow.ts";
import { WorkflowRow, parseGraph, workflowRunsMapping, workflowsMapping, workflowsPlan } from "./workflow-store.ts";
import { callWorkflowTool, workflowTools } from "./workflow-tools.ts";
import { jsonComplete } from "./scan.ts";

let database: Db = sqlite();

// Friday 2026-08-07T09:00:00Z, the fixture instant task-tools.test.ts uses.
const NOW: number = 1786093200000.0;

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_workflow_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  dropTable(database, workflowsMapping());
  dropTable(database, workflowRunsMapping());
  migrate(database, workflowsPlan(database));
}

type FileToolResultLike = {
  handled: bool,
  ok: bool,
  text: string,
};

function call(owner: string, name: string, args: string): FileToolResultLike {
  let got = callWorkflowTool(database, {
    owner: owner, agentId: "a1",
    name: name, args: args, nowMs: NOW,
  });
  let out: FileToolResultLike = { handled: got.handled, ok: got.ok, text: got.text };
  return out;
}

/** The quotedRight guard from task-tools.test.ts, holding the same line for
 *  these schemas: after a closing quote only a comma, colon, bracket or the
 *  end may follow, which is exactly what a bare quote in an example breaks. */
function quotedRight(text: string): bool {
  let i: int = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch == "\\") { escaped = true; }
      else if (ch == "\"") {
        inString = false;
        let j = i + 1;
        while (j < text.length && (text.charAt(j) == " " || text.charAt(j) == "\n")) { j = j + 1; }
        if (j < text.length) {
          let next = text.charAt(j);
          if (next != "," && next != ":" && next != "}" && next != "]") { return false; }
        }
      }
    } else if (ch == "\"") { inString = true; }
    i = i + 1;
  }
  return !inString;
}

function flowsFor(owner: string): WorkflowRow[] {
  return JSON.parse<WorkflowRow[]>(listWhere(database, workflowsMapping(),
    "owner = " + database.placeholder, [owner]));
}

const DRAFT = "{\"name\":\"Morning brief\",\"steps\":["
  + "{\"kind\":\"web_search\",\"text\":\"what changed about Lumen\",\"title\":\"Search\"},"
  + "{\"kind\":\"agent\",\"text\":\"Summarise {{prev}} in five lines\",\"title\":\"Summarise\"}"
  + "],\"schedule\":\"every weekday at 08:00\",\"timezone\":\"Europe/Paris\"}";

test("the twelve names are offered, and nothing else answers to them", () => {
  let specs = workflowTools();
  expect(specs.length == 12);
  expect(specs[0].name == "list_workflows");
  // By name, not index: an inserted verb shifted every position once and a
  // test that counts positions re-breaks on every addition.
  let drafting = "";
  let scheduling = "";
  let i0: int = 0;
  while (i0 < specs.length) {
    if (specs[i0].name == "draft_workflow") { drafting = specs[i0].schema; }
    if (specs[i0].name == "schedule_workflow") { scheduling = specs[i0].schema; }
    i0 = i0 + 1;
  }
  // The grammar and the step kinds are IN the descriptions.
  expect(drafting.indexOf("web_search") >= 0);
  expect(drafting.indexOf("tap buttons") >= 0);
  expect(scheduling.indexOf("every weekday at 08:00") >= 0);

  seeded();
  expect(!call("o1", "write_artifact", "{}").handled);
  expect(!call("o1", "schedule_task", "{}").handled);
});

test("every schema is a document, because a provider refuses the whole request over one", () => {
  let specs = workflowTools();
  let i: int = 0;
  while (i < specs.length) {
    expect(jsonComplete(specs[i].schema));
    expect(quotedRight(specs[i].schema));
    i = i + 1;
  }
});

test("a guest may not keep workflows, and is told what would make it possible", () => {
  seeded();
  let refused = call("guest:abc123", "draft_workflow", DRAFT);
  expect(refused.handled);
  expect(!refused.ok);
  expect(refused.text.indexOf("signing in") >= 0);
  expect(flowsFor("guest:abc123").length == 0);
});

test("a draft becomes a chain: start, the steps in order, end, and a schedule", () => {
  seeded();
  let made = call("o1", "draft_workflow", DRAFT);
  expect(made.ok);
  let rows = flowsFor("o1");
  expect(rows.length == 1);
  expect(rows[0].name == "Morning brief");
  expect(rows[0].kind == "every");
  expect(rows[0].cronExpr == "0 0 8 * * 1-5");
  expect(rows[0].tz == "Europe/Paris");
  // The first firing was computed — a scheduled workflow with nothing to fire
  // at is one that silently never runs.
  expect(rows[0].nextAt != "");

  let parsed = parseGraph(rows[0].graph);
  expect(parsed.ok);
  // START + two steps + END, wired in order, and the whole thing passes the
  // graph's own refusal — the builder is held to the same rules as a canvas.
  expect(parsed.graph.nodes.length == 4);
  expect(refuseGraph(parsed.graph) == "");
  expect(startOf(parsed.graph).schedule == "every weekday at 08:00");
  expect(parsed.graph.nodes[1].type == "WEB_SEARCH");
  expect(parsed.graph.nodes[2].type == "AGENT");
  expect(parsed.graph.nodes[2].instruction.indexOf("{{prev}}") >= 0);
  // Positions were placed by the builder, not left at zero for the canvas to
  // stack in a corner.
  expect(parsed.graph.nodes[2].x > parsed.graph.nodes[1].x);

  // The reply is prose somebody can read out, not JSON.
  expect(made.text.indexOf("Drafted") >= 0);
  expect(made.text.indexOf("web search") >= 0);
});

test("a step kind that is not offered is refused with the list that is", () => {
  seeded();
  let made = call("o1", "draft_workflow",
    "{\"name\":\"X\",\"steps\":[{\"kind\":\"kafka\",\"text\":\"consume\"}]}");
  expect(!made.ok);
  expect(made.text.indexOf("kafka") >= 0);
  expect(made.text.indexOf("web_search") >= 0);
  expect(flowsFor("o1").length == 0);
});

test("someone else's workflow is absent, not forbidden", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let theirs = flowsFor("o1")[0].id;
  let asked = call("o2", "show_workflow", "{\"workflow\":\"" + theirs + "\"}");
  expect(!asked.ok);
  expect(asked.text.indexOf("no workflow") >= 0);
  // And the same by name.
  let byName = call("o2", "delete_workflow", "{\"workflow\":\"Morning brief\"}");
  expect(!byName.ok);
  expect(flowsFor("o1").length == 1);
});

test("add_step splices before the end and the chain stays whole", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let added = call("o1", "add_step",
    "{\"workflow\":\"Morning brief\",\"kind\":\"model\",\"text\":\"Translate {{prev}} to French\",\"title\":\"Translate\"}");
  expect(added.ok);
  let parsed = parseGraph(flowsFor("o1")[0].graph);
  expect(parsed.ok);
  expect(parsed.graph.nodes.length == 5);
  expect(refuseGraph(parsed.graph) == "");
  // The prose lists it in walking order: after the summary, before the end.
  let prose = added.text;
  expect(prose.indexOf("Translate") > prose.indexOf("Summarise"));
});

test("add_step after a named step lands right there", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let added = call("o1", "add_step",
    "{\"workflow\":\"Morning brief\",\"kind\":\"model\",\"text\":\"Pick the three that matter\",\"title\":\"Filter\",\"after\":\"Search\"}");
  expect(added.ok);
  let prose = added.text;
  expect(prose.indexOf("Filter") > prose.indexOf("Search"));
  expect(prose.indexOf("Filter") < prose.indexOf("Summarise"));
  expect(refuseGraph(parseGraph(flowsFor("o1")[0].graph).graph) == "");
});

test("change_step rewrites the one field its kind carries", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let changed = call("o1", "change_step",
    "{\"workflow\":\"Morning brief\",\"step\":\"Search\",\"text\":\"Lumen language releases this week\"}");
  expect(changed.ok);
  let parsed = parseGraph(flowsFor("o1")[0].graph);
  expect(parsed.graph.nodes[1].query == "Lumen language releases this week");
  // The other kinds' fields did not move.
  expect(parsed.graph.nodes[1].instruction == "");
});

test("remove_step joins the chain around what it took out", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let removed = call("o1", "remove_step",
    "{\"workflow\":\"Morning brief\",\"step\":\"Search\"}");
  expect(removed.ok);
  let parsed = parseGraph(flowsFor("o1")[0].graph);
  expect(parsed.graph.nodes.length == 3);
  expect(refuseGraph(parsed.graph) == "");
  // START and END are kept, by refusal.
  let kept = call("o1", "remove_step", "{\"workflow\":\"Morning brief\",\"step\":\"start\"}");
  expect(!kept.ok);
  expect(kept.text.indexOf("start") >= 0);
});

test("schedule_workflow moves the schedule, and manual takes it away", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let moved = call("o1", "schedule_workflow",
    "{\"workflow\":\"Morning brief\",\"schedule\":\"every day at 07:30\"}");
  expect(moved.ok);
  let rows = flowsFor("o1");
  expect(rows[0].cronExpr == "0 30 7 * * *");
  // The zone the draft carried is kept, and named in the reply's civil time.
  expect(rows[0].tz == "Europe/Paris");

  let byHand = call("o1", "schedule_workflow",
    "{\"workflow\":\"Morning brief\",\"schedule\":\"manual\"}");
  expect(byHand.ok);
  let after = flowsFor("o1");
  expect(after[0].kind == "manual");
  expect(after[0].nextAt == "");
  expect(startOf(parseGraph(after[0].graph).graph).schedule == "");
});

test("run_workflow moves the next firing to now and fires nothing itself", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let before = flowsFor("o1")[0].nextAt;
  let asked = call("o1", "run_workflow", "{\"workflow\":\"Morning brief\"}");
  expect(asked.ok);
  expect(asked.text.indexOf("within about a minute") >= 0);
  let after = flowsFor("o1")[0];
  expect(after.nextAt == `${NOW}`);
  expect(after.nextAt != before);
  // Nothing ran: no run row exists, because running is the scheduler's alone.
  let runs = listWhere(database, workflowRunsMapping(),
    "workflow_id = " + database.placeholder, [after.id]);
  expect(runs == "[]");
});

test("pause and resume through change_workflow, and failures clear on resume", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let paused = call("o1", "change_workflow",
    "{\"workflow\":\"Morning brief\",\"enabled\":false}");
  expect(paused.ok);
  expect(!flowsFor("o1")[0].enabled);
  let resumed = call("o1", "change_workflow",
    "{\"workflow\":\"Morning brief\",\"enabled\":true}");
  expect(resumed.ok);
  let row = flowsFor("o1")[0];
  expect(row.enabled);
  expect(row.failures == 0);
  // A schedule that came back on has a firing to come back to.
  expect(row.nextAt != "");
});

test("delete_workflow removes the row and its history", () => {
  seeded();
  expect(call("o1", "draft_workflow", DRAFT).ok);
  let gone = call("o1", "delete_workflow", "{\"workflow\":\"Morning brief\"}");
  expect(gone.ok);
  expect(flowsFor("o1").length == 0);
});

test("the eleventh workflow is refused before it is a row", () => {
  seeded();
  let i: int = 0;
  while (i < 10) {
    let one = "{\"name\":\"Flow " + `${i}` + "\",\"steps\":[{\"kind\":\"model\",\"text\":\"say hi\"}]}";
    expect(call("o1", "draft_workflow", one).ok);
    i = i + 1;
  }
  let eleventh = call("o1", "draft_workflow",
    "{\"name\":\"One more\",\"steps\":[{\"kind\":\"model\",\"text\":\"say hi\"}]}");
  expect(!eleventh.ok);
  expect(eleventh.text.indexOf("10") >= 0);
  expect(flowsFor("o1").length == 10);
});

test("a chat can draft the telegram shapes, and publish what it drafted", () => {
  // A reply, an ask with tap-button options, and a connector step — the
  // week's vocabulary, buildable from a sentence.
  let made = call("o9", "draft_workflow",
    "{\"name\":\"Triage over chat\",\"steps\":["
    + "{\"kind\":\"reply\",\"text\":\"On it…\",\"title\":\"Ack\"},"
    + "{\"kind\":\"connector\",\"text\":\"\",\"title\":\"Issues\",\"server\":\"linear\",\"tool\":\"list_issues\",\"arguments\":{}},"
    + "{\"kind\":\"ask\",\"text\":\"What next?\",\"title\":\"Choose\",\"options\":\"Log it\\nSkip\"}"
    + "]}");
  expect(made.ok);
  let rows = flowsFor("o9");
  let g = parseGraph(rows[0].graph).graph;
  let kinds = "";
  let i: int = 0;
  while (i < g.nodes.length) { kinds = kinds + g.nodes[i].type + " "; i = i + 1; }
  expect(kinds.includes("TELEGRAM_REPLY"));
  expect(kinds.includes("MCP"));
  expect(kinds.includes("TELEGRAM_ASK"));
  let q = startOf(g);
  i = 0;
  let options = "";
  let server = "";
  while (i < g.nodes.length) {
    if (g.nodes[i].type == "TELEGRAM_ASK") { options = g.nodes[i].cases ?? ""; }
    if (g.nodes[i].type == "MCP") { server = g.nodes[i].serverId; }
    i = i + 1;
  }
  expect(options == "Log it\nSkip");
  expect(server == "linear");

  // Publish pins it: the draft column and the published column agree after,
  // and the reply says so in words a person can repeat.
  let out = call("o9", "publish_workflow", "{\"workflow\":\"Triage over chat\"}");
  expect(out.ok);
  expect(out.text.includes("Published"));
  let after = flowsFor("o9");
  expect((after[0].publishedGraph ?? "") == after[0].graph);
});

test("a said switch lands valid, and connect_steps re-points one branch", () => {
  let made = call("o9", "add_step",
    "{\"workflow\":\"Triage over chat\",\"kind\":\"switch\",\"text\":\"\",\"title\":\"Route\",\"cases\":\"Log it\\nSkip\",\"after\":\"s3\"}");
  expect(made.ok);
  let rows = flowsFor("o9");
  let g = parseGraph(rows[0].graph).graph;
  // Every branch exists from the first save: cases and else all point at
  // whatever followed the anchor, so the graph never passes through a state
  // the engine would refuse.
  let fanned: int = 0;
  let sid = "";
  let i: int = 0;
  while (i < g.nodes.length) { if (g.nodes[i].type == "SWITCH") { sid = g.nodes[i].id; } i = i + 1; }
  i = 0;
  while (i < g.edges.length) { if (g.edges[i].from == sid) { fanned = fanned + 1; } i = i + 1; }
  expect(fanned == 3);

  // Every branch starts at the old next, so re-pointing a CASE to the same
  // place proves nothing — the meaningful move is a plain edge: route the
  // connector straight to the switch, skipping the ask.
  let wired = call("o9", "connect_steps",
    "{\"workflow\":\"Triage over chat\",\"from\":\"Issues\",\"to\":\"Route\"}");
  expect(wired.ok);
  let g2 = parseGraph(flowsFor("o9")[0].graph).graph;
  i = 0;
  let issuesTo = "";
  let askIn = 0;
  let askId = "";
  let j: int = 0;
  while (j < g2.nodes.length) { if (g2.nodes[j].type == "TELEGRAM_ASK") { askId = g2.nodes[j].id; } j = j + 1; }
  while (i < g2.edges.length) {
    if (g2.edges[i].to == askId) { askIn = askIn + 1; }
    if (g2.edges[i].when == "") {
      let f = g2.edges[i].from;
      let isIssues = false;
      let k: int = 0;
      while (k < g2.nodes.length) { if (g2.nodes[k].id == f && g2.nodes[k].type == "MCP") { isIssues = true; } k = k + 1; }
      if (isIssues) { issuesTo = g2.edges[i].to; }
    }
    i = i + 1;
  }
  expect(issuesTo == sid);
  // The ask is now unwired — reachable by nobody, refused by nothing: a
  // dangling step is the canvas's to reconnect, not a reason to lose a save.
  expect(askIn == 0);
});

test("a reply's file rides in from a sentence, and none takes it away", () => {
  let made = call("o10", "draft_workflow",
    "{\"name\":\"Report over chat\",\"steps\":["
    + "{\"kind\":\"agent\",\"text\":\"Write the report to /report.md\",\"title\":\"Write\"},"
    + "{\"kind\":\"reply\",\"text\":\"{{prev}}\",\"title\":\"Send\",\"file\":\"/report.md\"}"
    + "]}");
  expect(made.ok);
  let body = replyBody("o10");
  expect(body == "/report.md");

  // change_step moves it, and "none" clears it — an empty string cannot be
  // sent to mean "clear", so the word does the job.
  expect(call("o10", "change_step", "{\"workflow\":\"Report over chat\",\"step\":\"Send\",\"file\":\"/summary.md\"}").ok);
  expect(replyBody("o10") == "/summary.md");
  expect(call("o10", "change_step", "{\"workflow\":\"Report over chat\",\"step\":\"Send\",\"file\":\"none\"}").ok);
  expect(replyBody("o10") == "");

  // A file on a step that cannot send one is a refusal, not a silent drop.
  let wrong = call("o10", "change_step", "{\"workflow\":\"Report over chat\",\"step\":\"Write\",\"file\":\"/x.md\"}");
  expect(!wrong.ok);
  expect(wrong.text.includes("reply"));
});

test("a rename does not cost a switch its cases", () => {
  // The o9 workflow of the earlier tests still holds its Route switch.
  let renamed = call("o9", "change_step",
    "{\"workflow\":\"Triage over chat\",\"step\":\"Route\",\"title\":\"Routing\"}");
  expect(renamed.ok);
  let g = parseGraph(flowsFor("o9")[0].graph).graph;
  let kept = "";
  let i: int = 0;
  while (i < g.nodes.length) {
    if (g.nodes[i].type == "SWITCH") { kept = g.nodes[i].cases ?? ""; }
    i = i + 1;
  }
  expect(kept == "Log it\nSkip");
});

function replyBody(owner: string): string {
  let g = parseGraph(flowsFor(owner)[0].graph).graph;
  let i: int = 0;
  while (i < g.nodes.length) {
    if (g.nodes[i].type == "TELEGRAM_REPLY") { return g.nodes[i].body; }
    i = i + 1;
  }
  return "(no reply step)";
}

import { reservedToolNames, reservedHere } from "./reserved.ts";
import { ToolSpec } from "./provider.ts";
import { artifactTools, delegateEnvTool, findToolsSpec, Mounted } from "./tools.ts";
import { workspaceTools } from "./workspace.ts";
import { taskTools } from "./task-tools.ts";
import { workflowTools } from "./workflow-tools.ts";
import { triggerTools } from "./trigger-tools.ts";
import { agentTools } from "./agent-tools.ts";
import { projectTools } from "./project-tools.ts";
import { knowledgeTools } from "./knowledge-tools.ts";

function namesOf(specs: ToolSpec[], into: string[]): void {
  let i: int = 0;
  while (i < specs.length) {
    into.push(specs[i].name);
    i = i + 1;
  }
}

test("every name a family defines is reserved, so the list cannot drift", () => {
  let mine: string[] = [];
  namesOf(artifactTools(), mine);
  namesOf(taskTools(), mine);
  namesOf(workflowTools(), mine);
  namesOf(triggerTools(), mine);
  namesOf(agentTools(), mine);
  namesOf(projectTools(), mine);
  namesOf(knowledgeTools(), mine);
  let ws = workspaceTools();
  let w: int = 0;
  while (w < ws.length) {
    mine.push(ws[w].name);
    w = w + 1;
  }
  mine.push(delegateEnvTool().name);
  // run_script, serve_env and use_skill need a database to build their specs,
  // so they are named here rather than gathered.
  mine.push("run_script");
  mine.push("serve_env");
  mine.push("use_skill");

  let missing: string[] = [];
  let i: int = 0;
  while (i < mine.length) {
    if (!reservedHere(mine[i])) {
      missing.push(mine[i]);
    }
    i = i + 1;
  }
  expect(missing.length == 0);
});

test("the names that actually collided are the ones a big server brings", () => {
  // Linear offers both, and mounting either one is what made a provider
  // refuse the whole request.
  expect(reservedHere("list_projects"));
  expect(reservedHere("list_documents"));
  // and the door to the deferred ones is ours too
  expect(reservedHere("find_tools"));
  expect(reservedHere("send_email"));
  // while a server's own vocabulary is left alone
  expect(!reservedHere("list_issues"));
  expect(!reservedHere("list_teams"));
  expect(!reservedHere("list_cycles"));
  expect(!reservedHere("get_issue"));
});

test("the reserved list holds no repeats of its own", () => {
  let held = reservedToolNames();
  let i: int = 0;
  while (i < held.length) {
    let j = i + 1;
    while (j < held.length) {
      expect(held[i] != held[j]);
      j = j + 1;
    }
    i = i + 1;
  }
});

import { ToolSpec } from "../../../provider.ts";
import { agentTools } from "../../../agent-tools.ts";
import { knowledgeTools } from "../../../knowledge-tools.ts";
import { projectTools } from "../../../project-tools.ts";
import { taskTools } from "../../../task-tools.ts";
import { triggerTools } from "../../../trigger-tools.ts";
import { workflowTools } from "../../../workflow-tools.ts";

export function mcpExportedTools(): ToolSpec[] {
  let out: ToolSpec[] = [];
  let families: ToolSpec[][] = [
    taskTools(), workflowTools(), triggerTools(), agentTools(),
    knowledgeTools(), projectTools(),
  ];
  let f: int = 0;
  while (f < families.length) {
    let one = families[f];
    let i: int = 0;
    while (i < one.length) {
      if (one[i].name != "set_banner") {
        out.push(one[i]);
      }
      i = i + 1;
    }
    f = f + 1;
  }
  return out;
}

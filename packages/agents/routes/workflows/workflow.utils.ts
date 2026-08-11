import { WorkflowRow } from "../../workflow-store.ts";

export function withoutGraph(body: string, graphText: string): string {
  if (graphText == "") {
    return body;
  }
  let graphAt = body.indexOf(graphText);
  if (graphAt < 0) {
    return body;
  }
  return body.slice(0, graphAt) + "\"\"" + body.slice(graphAt + graphText.length);
}


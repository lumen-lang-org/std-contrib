// A supervisor with two specialist subagents, live against Mistral.
//
// The supervisor is an ordinary agent whose tools happen to be other agents.
// Each child gets only the task the supervisor writes for it and returns only
// its final answer — the supervisor's history stays clean however much the
// children work.
//
// The calculator child has a real tool of its own, so a delegation here is a
// genuine two-level run: supervisor -> child -> tool -> child -> supervisor.
//
// Run:
//   export MISTRAL_API_KEY="..."
//   lumen compile packages/ai/examples/supervisor.ts
//   ./supervisor

import { subAgent, subAgentTools, mistralAgent, runAgent, agentTrace, defineTool, system, user } from "../ai.ts";
import { requireEnv } from "./env.ts";

let apiKey = requireEnv("MISTRAL_API_KEY");
const MODEL = "mistral-large-latest";

// A real tool for the calculator child: sums the integers in its input.
//
// The arithmetic lives in a top-level function because a closure that
// reassigns a local of its own does not coerce to the tool's function type —
// the same restriction as captured variables, so the closure only delegates.
function sumNumbers(input: string): string {
  let total: int = 0;
  let parts = input.replace(",", " ").split(" ");
  let i: int = 0;
  while (i < parts.length) {
    let n = parseInt(parts[i].trim());
    if (n != null) { total = total + n; }
    i = i + 1;
  }
  return `${total}`;
}

function sumTool(): Tool {
  return defineTool(
    "sum",
    "Add integers. Input: the numbers separated by spaces.",
    "numbers separated by spaces",
    (input: string) => {
      return sumNumbers(input);
    },
  );
}

function noTools(): Tool[] {
  let none: Tool[] = [];
  return none;
}

// Two specialists. The descriptions are what the supervisor's model reads when
// deciding whom to delegate to.
let calcTools: Tool[] = [sumTool()];
let subs: SubAgent[] = [
  subAgent(
    "calculator",
    "Does arithmetic. Use it for any question involving numbers.",
    "mistral", apiKey, MODEL,
    "You are a careful calculator. Use the sum tool for addition rather than computing yourself.",
    calcTools, 4,
  ),
  subAgent(
    "poet",
    "Writes short verse. Use it when the user wants creative text.",
    "mistral", apiKey, MODEL,
    "You write exactly two rhyming lines, nothing more.",
    noTools(), 2,
  ),
];

let tools = subAgentTools(subs);
let model = mistralAgent(apiKey, MODEL, tools);

let history: Message[] = [
  system("You are a supervisor. Delegate to your tools rather than answering"
    + " yourself: calculator for numbers, poet for verse. Then combine their"
    + " results into one reply."),
  user("Add 17, 25 and 58 for me, and then give me a two-line poem about the result."),
];

let result = runAgent(model, tools, history, 6);

console.log(agentTrace(result));
console.log("");
console.log("supervisor's answer:");
console.log(result.answer);

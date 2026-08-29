/** A named set of cases. `description` is what the console shows under the
 *  name, and is the only thing distinguishing two sets someone made a month
 *  apart. */
export type EvalDatasetBody = {
  name: string,
  description: string,
};

/** One case: a question, the answer it should reach, and what it should have
 *  touched on the way. The three lists are optional in the sense that an empty
 *  one scores 1.0, so a case that only checks the answer leaves them empty. */
export type EvalCaseBody = {
  dataset: string,
  question: string,
  expected: string,
  tools: string[],
  agents: string[],
  scopes: string[],
};

/** What to run, against whom, and who judges. `judgeAgentId` is "" when there
 *  is no judge, and the scoring falls back to comparing the numbers in the
 *  reference answer. */
export type EvalRunBody = {
  agentId: string,
  judgeAgentId: string,
  dataset: string,
  runName: string,
  maxItems: int,
  onlyItem: string,
};

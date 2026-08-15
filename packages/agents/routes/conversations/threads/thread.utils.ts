import { Db } from "../../../../plume/driver.ts";
import { askedChoice } from "../../../api-core.ts";
import { jsonFind } from "../../../scan.ts";
import { envList } from "../../../environments.ts";
import { AgentRun } from "../../../run.ts";
import { LiveStep, Thought, stepMillis } from "../../../steps.ts";
import { ModelPick, threadMessageRows } from "../../../threads.ts";
import { WireRef } from "../../../artifacts-fence.ts";
import { RefView } from "./dtos/ref-view.dto.ts";
import { StepView } from "./dtos/step-view.dto.ts";
import { ThoughtView } from "./dtos/thought-view.dto.ts";

export function choiceWasSent(body: string): bool {
  if (body == "") {
    return false;
  }
  return jsonFind(body, "modelChoiceId") >= 0;
}

export function askedPick(body: string): ModelPick {
  let pick: ModelPick = { choiceId: askedChoice(body), sent: choiceWasSent(body) };
  return pick;
}
/** The line a starting point is chosen by: what was asked for, in the words of
 *  whoever prepared it. The request rather than the reply — a reply describes
 *  what was built, and by then the reader has already had to decide. */
export function threadBlurb(db: Db, threadId: string): string {
  let said = threadMessageRows(db, threadId);
  let blurb = "";
  let i: int = 0;
  while (i < said.length) {
    if (said[i].role == "user" && said[i].text.trim() != "") {
      blurb = said[i].text;
      break;
    }
    if (blurb == "" && said[i].text.trim() != "") {
      blurb = said[i].text;
    }
    i = i + 1;
  }
  blurb = blurb.split("\n").join(" ").trim();
  if (blurb.length <= 180) {
    return blurb;
  }
  // Cut at a space, so the card does not end mid-word.
  let cut = blurb.slice(0, 180);
  let back = cut.lastIndexOf(" ");
  if (back > 120) {
    cut = cut.slice(0, back);
  }
  return cut + "…";
}

/** Whether taking this conversation gives you something running. */
export function threadServes(db: Db, threadId: string): bool {
  let held = envList(db, threadId);
  let i: int = 0;
  while (i < held.length) {
    if (held[i].serveCmd != "" && held[i].servePort != 0) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function withNotes(run: AgentRun, more: string[]): AgentRun {
  let notes: string[] = [];
  let i: int = 0;
  while (i < run.notes.length) {
    notes.push(run.notes[i]);
    i = i + 1;
  }
  let m: int = 0;
  while (m < more.length) {
    notes.push(more[m]);
    m = m + 1;
  }
  let out: AgentRun = {
    ok: run.ok, text: run.text, body: run.body, status: run.status,
    agentName: run.agentName, promptVersion: run.promptVersion,
    modelApiName: run.modelApiName, error: run.error,
    context: run.context, retrieved: run.retrieved, steps: run.steps,
    stopReason: run.stopReason, rounds: run.rounds,
    inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    notes: notes, calledTools: run.calledTools, calledAgents: run.calledAgents,
    spans: run.spans,
  };
  return out;
}

export function refViews(refs: WireRef[]): RefView[] {
  let out: RefView[] = [];
  let i: int = 0;
  while (i < refs.length) {
    let one: RefView = { slot: refs[i].slot, version: refs[i].version, path: refs[i].path };
    out.push(one);
    i = i + 1;
  }
  return out;
}

export function thoughtViews(thoughts: Thought[]): ThoughtView[] {
  let out: ThoughtView[] = [];
  let i: int = 0;
  while (i < thoughts.length) {
    let one: ThoughtView = {
      seq: thoughts[i].seq, rotation: thoughts[i].rotation,
      depth: thoughts[i].depth, text: thoughts[i].text,
    };
    out.push(one);
    i = i + 1;
  }
  return out;
}

export function stepViews(live: LiveStep[]): StepView[] {
  let out: StepView[] = [];
  let i: int = 0;
  while (i < live.length) {
    let one: StepView = {
      seq: live[i].seq,
      depth: live[i].depth,
      rotation: live[i].rotation,
      idx: live[i].idx,
      kind: live[i].kind,
      name: live[i].name,
      target: live[i].target,
      args: live[i].args,
      running: live[i].endedAt == "",
      ok: live[i].ok,
      millis: stepMillis(live[i]),
      result: live[i].result,
    };
    out.push(one);
    i = i + 1;
  }
  return out;
}

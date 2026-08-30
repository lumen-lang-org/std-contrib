import { traceId, tracing, tracerWithMoreSpans, tracerWithSession } from "../tracing/tracing.ts";
import { masterKey } from "./credentials.ts";
import { openDatabase } from "./database.ts";
import { settleTurn } from "./feed.ts";
import { recordRun } from "./runlog.ts";
import { enqueueTrace } from "./trace-outbox.ts";
import { tracerFor } from "./trace.ts";
import { ModelPick, runInThreadWith, threadOwner } from "./threads.ts";
import { wireView } from "./artifacts-fence.ts";
import { RefView } from "./routes/conversations/threads/dtos/ref-view.dto.ts";
import { refViews, withNotes } from "./routes/conversations/threads/thread.utils.ts";

export type DetachedTurn = {
  threadId: string,
  seq: int,
  agentId: string,
  owner: string,
  text: string,
  choiceId: string,
  choiceSent: bool,
  think: bool,
  scope: string,
  titledElsewhere: bool,
  mustSearch: bool,
};

export type TurnAnswer = {
  runId: string,
  ok: bool,
  text: string,
  refs: RefView[],
  seq: int,
  modelChoiceId: string,
  routeNote: string,
  toolCalls: int,
  inputTokens: int,
  outputTokens: int,
  traceId: string,
  error: string,
};

export function turnFailed(seq: int, why: string): TurnAnswer {
  let none: RefView[] = [];
  let out: TurnAnswer = {
    runId: "", ok: false, text: "", refs: none, seq: seq,
    modelChoiceId: "", routeNote: "", toolCalls: 0,
    inputTokens: 0, outputTokens: 0, traceId: "", error: why,
  };
  return out;
}

export function runTurnDetached(askJson: string): int {
  let ask: DetachedTurn = JSON.parse<DetachedTurn>(askJson);
  try {
    let db = openDatabase();
    try {
      let master = masterKey();
      let pick: ModelPick = { choiceId: ask.choiceId, sent: ask.choiceSent };
      let tracer = tracerWithSession(tracerFor(db, master), ask.threadId, ask.owner);
      let answered = runInThreadWith(db, ask.threadId, {
        userText: ask.text, master: master, tracer: tracer, pick: pick,
        think: ask.think,
        scope: ask.scope,
        titledElsewhere: ask.titledElsewhere,
        mustSearch: ask.mustSearch,
      });
      let run = answered.run;
      let runId = recordRun(db, {
        agentId: ask.agentId, threadId: ask.threadId,
        owner: threadOwner(db, ask.threadId),
        question: ask.text, run: withNotes(run, answered.notes),
        modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
      });
      let traced = "";
      if (tracing(tracer) && run.spans.length > 0) {
        let queued = enqueueTrace(db, tracerWithMoreSpans(tracer, run.spans));
        if (queued == "") {
          traced = traceId(tracer);
        } else {
          console.error("trace outbox: a trace could not be queued — " + queued);
        }
      }
      let view = wireView(answered.text);
      let answer: TurnAnswer = {
        runId: runId,
        ok: run.ok,
        text: view.text,
        refs: refViews(view.refs),
        seq: answered.baseSeq,
        modelChoiceId: answered.modelChoiceId,
        routeNote: answered.routeNote,
        toolCalls: run.steps.length,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        traceId: traced,
        error: run.error,
      };
      settleTurn(db, ask.threadId, ask.seq, JSON.stringify(answer), `${Date.now()}`);
    }
    catch (e) {
      console.error("the turn did not finish: " + e.message);
      settleTurn(db, ask.threadId, ask.seq,
        JSON.stringify(turnFailed(ask.seq, e.message)), `${Date.now()}`);
    }
  }
  catch (e) {
    console.error("the turn had no connection of its own — " + e.message);
  }
  return 0;
}

import { Db } from "../../../../plume/driver.ts";
import { existsById, findById } from "../../../../plume/plume.ts";
import { Reply, Respond, BadRequest, CreatedJson, NotFound, OkJson } from "../../../../rest/server.ts";
import { flush, traceId, tracing, tracerWithMoreSpans, tracerWithSession } from "../../../../tracing/tracing.ts";
import { GUEST_DAILY_RUNS, askedChoice, choiceFault, guestQuotaJson, guestTag, stamp } from "../../../api-core.ts";
import { TURN_SEQ_NONE } from "../../../artifacts.ts";
import { wireView, WireRef } from "../../../artifacts-fence.ts";
import { asArticleContext, feedById, storyById } from "../../../discover.ts";
import { envEnsure, envList } from "../../../environments.ts";
import { envMaterialise } from "../../../env-sync.ts";
import { holdsOwner, owningTag } from "../../../owner.ts";
import { assignProject, projectsMapping } from "../../../projects.ts";
import { userTurn } from "../../../provider.ts";
import { recordRun } from "../../../runlog.ts";
import { askCancel, clearCancel } from "../../../schema.ts";
import { modelChoiceRepository } from "../../inference/models/entities/model-choice.entity.ts";
import { ModelChoiceBody } from "../../inference/model-choices/dtos/model-choice-body.dto.ts";
import { jsonRaw, jsonText } from "../../../scan.ts";
import { LiveStep, Thought, latestRound, partialOf, roundRunning, stepsOfRound, stepsOfThread, thoughtsOfRound, thoughtsOfThread } from "../../../steps.ts";
import { ThreadTurnRow, appendTurns, listReplayable, listThreads, markReplayable, nameThread, openThread, ownedThread, rememberChoice, remixThread, runInThreadWith, threadChoice, threadMessageRows, threadOwner, threadTitle } from "../../../threads.ts";
import { tracerFor } from "../../../trace.ts";
import { nextUtcMidnightIso, runsSince, secondsToUtcMidnight, utcDayStartText } from "../../../usage.ts";
import { agentRepository } from "../../authoring/agents/entities/agent.entity.ts";
import { AnsweredView } from "./dtos/answered-view.dto.ts";
import { CancelAskedView } from "./dtos/cancel-asked-view.dto.ts";
import { GuestAnsweredView } from "./dtos/guest-answered-view.dto.ts";
import { MessageView } from "./dtos/message-view.dto.ts";
import { RemixedView } from "./dtos/remixed-view.dto.ts";
import { ReplayableSetView } from "./dtos/replayable-set-view.dto.ts";
import { ReplayableThreadView } from "./dtos/replayable-thread-view.dto.ts";
import { RoundView } from "./dtos/round-view.dto.ts";
import { StepView } from "./dtos/step-view.dto.ts";
import { ThoughtView } from "./dtos/thought-view.dto.ts";
import { ThreadFromStoryView } from "./dtos/thread-from-story-view.dto.ts";
import { ThreadOpenedView } from "./dtos/thread-opened-view.dto.ts";
import { ThreadRowView } from "./dtos/thread-row-view.dto.ts";
import { TranscriptView } from "./dtos/transcript-view.dto.ts";
import { askedPick, refViews, stepViews, threadBlurb, threadServes, thoughtViews, withNotes } from "./thread.utils.ts";

export class ThreadService {
  database: Db;
  master: string;

  constructor(database: Db, master: string) {
    this.database = database;
    this.master = master;
  }

  replayable(limit: int): ReplayableThreadView[] {
    let rows = listReplayable(this.database, limit);
    let out: ReplayableThreadView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: ReplayableThreadView = {
        id: rows[i].id, agentId: rows[i].agentId, createdAt: rows[i].createdAt,
        title: rows[i].title, replayable: true,
        blurb: threadBlurb(this.database, rows[i].id),
        runs: threadServes(this.database, rows[i].id),
      };
      out.push(one);
      i = i + 1;
    }
    return out;
  }

  offer(id: string, body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"replayable\":true}");
    }
    let on = jsonRaw(body, "replayable") == "true";
    let wrong = markReplayable(this.database, id, on);
    if (wrong != "") {
      return BadRequest(wrong);
    }
    let v: ReplayableSetView = { id: id, replayable: on };
    return OkJson(v);
  }

  remix(id: string, owner: string): Reply {
    let made = remixThread(this.database, { sourceId: id, owner: owner, now: stamp() });
    if (made.threadId == "") {
      return NotFound(made.fault);
    }
    // A fork carries the environment as well as the files: a starting point
    // that came up running should come up running for whoever takes it.
    let from = envList(this.database, id);
    let serves = false;
    let f: int = 0;
    while (f < from.length) {
      let was = from[f];
      f = f + 1;
      if (was.servePort == 0 || was.serveCmd == "") {
        continue;
      }
      let up = envEnsure(this.database, {
        threadId: made.threadId, name: was.name, image: was.image,
        network: true, serve: true, command: was.serveCmd, start: false,
        now: stamp(),
      });
      if (!up.ok) {
        continue;
      }
      serves = true;
      // The container is made empty and the files are the fork's own, so they
      // go in here. Left out, the serve that follows finds nothing to serve:
      // the route that usually materialises does it only for a container it
      // created itself, and this one was already there by then.
      if (up.created) {
        envMaterialise(this.database, up.slug, "/tmp/agents-env-" + up.slug);
      }
    }
    let v: RemixedView = { id: made.threadId, files: made.files,
      turns: made.turns, serves: serves };
    return CreatedJson(v);
  }

  listing(tags: string[], limit: int, offset: int, project: string): ThreadRowView[] {
    let rows = listThreads(this.database, {
      tags: tags,
      limit: limit,
      offset: offset,
      project: project,
    });
    let out: ThreadRowView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let one: ThreadRowView = {
        id: rows[i].id, agentId: rows[i].agentId, createdAt: rows[i].createdAt,
        title: rows[i].title, replayable: rows[i].replayable, projectId: rows[i].projectId,
      };
      out.push(one);
      i = i + 1;
    }
    return out;
  }

  fromStory(body: string, owner: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"storyId\":\"tech-en:ab12cd34\",\"agentId\":\"a1\"}");
    }
    let storyId = jsonText(body, "storyId");
    let agentId = jsonText(body, "agentId");
    if (storyId == "" || agentId == "") {
      return BadRequest("a storyId and an agentId are required");
    }
    if (!existsById(this.database, agentRepository(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    let story = storyById(this.database, storyId);
    if (story.id == "") {
      return NotFound("story " + storyId);
    }

    let id = openThread(this.database, {
      agentId: agentId,
      owner: owner,
      now: stamp(),
    });
    if (id == "") {
      return BadRequest("the thread could not be opened");
    }

    let chosen = askedChoice(body);
    if (chosen != "" && choiceFault(this.database, chosen) == "") {
      if (rememberChoice(this.database, id, chosen) != "") {
        chosen = "";
      }
    } else {
      chosen = "";
    }

    let feed = feedById(this.database, story.feedId);
    let seed = [userTurn(asArticleContext(story, feed.topic))];
    let wrote = appendTurns(this.database, id, seed, 0);
    if (wrote != "") {
      return BadRequest("the article could not be attached: " + wrote);
    }

    // The view below reports this headline as the thread's title, so a name
    // that did not land makes the reply disagree with the row.
    let named = nameThread(this.database, id, story.headline);
    if (named != "") {
      console.error("threads: the conversation opened from story " + storyId
        + " could not be named and will show untitled — " + named);
    }

    let v: ThreadFromStoryView = {
      id: id, agentId: agentId, modelChoiceId: chosen, title: story.headline,
    };
    return CreatedJson(v);
  }

  open(body: string, tags: string[]): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\"}");
    }
    let agentId = jsonText(body, "agentId");
    if (agentId == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\"}");
    }
    if (!existsById(this.database, agentRepository(), agentId)) {
      return BadRequest("no agent " + agentId);
    }
    let chosen = askedChoice(body);
    let refused = choiceFault(this.database, chosen);
    if (refused != "") {
      return BadRequest(refused);
    }
    let id = openThread(this.database, {
      agentId: agentId,
      owner: owningTag(tags),
      now: stamp(),
    });
    if (id == "") {
      return BadRequest("the thread could not be opened");
    }

    let kept = chosen;
    if (chosen != "") {
      if (rememberChoice(this.database, id, chosen) != "") {
        kept = "";
      }
    }
    let filed = jsonText(body, "projectId");
    if (filed != "") {
      let held = findById(this.database, projectsMapping(), filed);
      if (held == "" || !holdsOwner(tags, jsonText(held, "owner"))) {
        filed = "";
      } else if (assignProject(this.database, id, filed) != "") {
        filed = "";
      }
    }
    let v: ThreadOpenedView = {
      id: id, agentId: agentId, modelChoiceId: kept, projectId: filed,
    };
    return CreatedJson(v);
  }

  steps(id: string, asked: string): RoundView {
    let round = latestRound(this.database, id);
    let live: LiveStep[] = [];
    let thoughts: Thought[] = [];
    if (asked == "all") {
      round = TURN_SEQ_NONE;
      live = stepsOfThread(this.database, id);
      thoughts = thoughtsOfThread(this.database, id);
    } else {
      if (asked != "") {
        round = parseInt(asked, 10) ?? -1;
      }
      if (round >= 0) {
        live = stepsOfRound(this.database, id, round);
        thoughts = thoughtsOfRound(this.database, id, round);
      }
    }
    let partialText = "";
    if (asked != "all") {
      partialText = partialOf(this.database, id, round);
    }
    let v: RoundView = {
      seq: round, running: roundRunning(live), partial: partialText,
      thoughts: thoughtViews(thoughts), steps: stepViews(live),
    };
    return v;
  }

  cancel(id: string): Reply {
    let fault = askCancel(this.database, id);
    if (fault != "") {
      return BadRequest(fault);
    }
    let v: CancelAskedView = { asked: true };
    return OkJson(v);
  }

  say(id: string, body: string, tags: string[]): Reply {
    let agentId = ownedThread(this.database, id, tags);
    // Before anything else: with the previous stop still on the row, the run
    // below would come straight back as "cancelled" and burn the turn.
    let cleared = clearCancel(this.database, id);
    if (cleared != "") {
      return BadRequest("the last stop on this conversation could not be lifted, so a new "
        + "message would come back cancelled — " + cleared);
    }
    if (body == "") {
      return BadRequest("a body is required: {\"text\":\"...\"}");
    }
    let text = jsonText(body, "text");
    if (text == "") {
      return BadRequest("nothing to ask: \"text\" is empty");
    }

    let pick = askedPick(body);
    let noSuchChoice = choiceFault(this.database, pick.choiceId);
    if (noSuchChoice != "") {
      return BadRequest(noSuchChoice);
    }

    if (pick.choiceId != "") {
      let pickedRow = findById(this.database, modelChoiceRepository(), pick.choiceId);
      if (pickedRow != "") {
        let picked: ModelChoiceBody = JSON.parse<ModelChoiceBody>(pickedRow);
        if (picked.tier == "premium") {
          return BadRequest(picked.label + " is coming soon — it is announced, not offered yet");
        }
      }
    }

    let guest = guestTag(tags);
    if (guest != "") {
      let atGate = Date.now();
      let used = runsSince(this.database, guest, utcDayStartText(atGate));
      if (used >= GUEST_DAILY_RUNS) {
        let refusal = Respond(429, guestQuotaJson(used, nextUtcMidnightIso(atGate)), "application/json");
        refusal.headers.set("retry-after", `${secondsToUtcMidnight(atGate)}`);
        return refusal;
      }
    }

    let tracer = tracerWithSession(
      tracerFor(this.database, this.master), id, owningTag(tags));
    let answered = runInThreadWith(this.database, id, {
      userText: text, master: this.master, tracer: tracer, pick: pick,
      think: jsonText(body, "think") == "true",
      scope: jsonText(body, "scope"),
    });
    let run = answered.run;
    let runId = recordRun(this.database, {
      agentId: agentId, threadId: id,
      owner: threadOwner(this.database, id),
      question: text, run: withNotes(run, answered.notes),
      modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
    });

    let traced = "";
    if (tracing(tracer) && run.spans.length > 0) {
      if (flush(tracerWithMoreSpans(tracer, run.spans)).ok) {
        traced = traceId(tracer);
      }
    }
    let view = wireView(answered.text);
    let said: AnsweredView = {
      runId: runId,
      ok: run.ok,
      text: view.text,
      refs: refViews(view.refs),
      seq: answered.baseSeq,
      modelChoiceId: answered.modelChoiceId,
      routeNote: answered.routeNote,
      toolCalls: run.steps.length,
      steps: stepViews(stepsOfRound(this.database, id, answered.baseSeq)),
      thoughts: thoughtViews(thoughtsOfRound(this.database, id, answered.baseSeq)),
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      traceId: traced,
      error: run.error,
    };
    if (guest == "") {
      return OkJson(said);
    }
    let left = GUEST_DAILY_RUNS - runsSince(this.database, guest, utcDayStartText(Date.now()));
    if (left < 0) {
      left = 0;
    }
    let counted: GuestAnsweredView = {
      runId: said.runId,
      ok: said.ok,
      text: said.text,
      refs: said.refs,
      seq: said.seq,
      modelChoiceId: said.modelChoiceId,
      routeNote: said.routeNote,
      toolCalls: said.toolCalls,
      steps: said.steps,
      thoughts: said.thoughts,
      inputTokens: said.inputTokens,
      outputTokens: said.outputTokens,
      traceId: said.traceId,
      error: said.error,
      guestRemaining: left,
    };
    return OkJson(counted);
  }

  transcript(id: string, tags: string[]): TranscriptView {
    let mine = ownedThread(this.database, id, tags) != "";
    let said: ThreadTurnRow[] = threadMessageRows(this.database, id);
    let out: MessageView[] = [];
    let i: int = 0;
    while (i < said.length) {
      if (said[i].role == "assistant") {
        let view = wireView(said[i].text);
        let one: MessageView = {
          role: said[i].role, seq: said[i].seq, text: view.text, refs: refViews(view.refs),
        };
        out.push(one);
      } else {
        let none: WireRef[] = [];
        let one: MessageView = {
          role: said[i].role, seq: said[i].seq, text: said[i].text, refs: refViews(none),
        };
        out.push(one);
      }
      i = i + 1;
    }
    let v: TranscriptView = {
      modelChoiceId: threadChoice(this.database, id),
      title: threadTitle(this.database, id),
      mine: mine,
      messages: out,
    };
    return v;
  }
}

import { Db } from "../../../../plume/driver.ts";
import { DbAssignment, existsById, findById, setOn } from "../../../../plume/plume.ts";
import { Reply, Respond, BadRequest, CreatedJson, NotFound, OkJson } from "../../../../rest/server.ts";
import { traceId, tracing, tracerWithMoreSpans, tracerWithSession } from "../../../../tracing/tracing.ts";
import { enqueueTrace } from "../../../trace-outbox.ts";
import { GUEST_DAILY_RUNS, askedChoice, choiceFault, guestQuotaJson, guestTag, stamp } from "../../../api-core.ts";
import { TURN_SEQ_NONE, binaryKind, listArtifacts } from "../../../artifacts.ts";
import { wireView, WireRef } from "../../../artifacts-fence.ts";
import { envEnsure, envList } from "../../../environments.ts";
import { scriptImageForEnv } from "../../../run-script.ts";
import { envMaterialise } from "../../../env-sync.ts";
import { holdsOwner, owningTag } from "../../../owner.ts";
import { assignProject, projectsMapping } from "../../../projects.ts";
import { userTurn } from "../../../provider.ts";
import { recordRun } from "../../../runlog.ts";
import { threadRepository } from "./entities/thread.entity.ts";
import { modelChoiceRepository } from "../../inference/models/entities/model-choice.entity.ts";
import { ModelChoiceBody } from "../../inference/model-choices/dtos/model-choice-body.dto.ts";
import { jsonRaw, jsonText } from "../../../scan.ts";
import { LiveStep, Thought, latestRound, partialOf, roundRunning, stepsOfRound, stepsOfThread, thoughtsOfRound, thoughtsOfThread } from "../../../steps.ts";
import { ThreadTurnRow, threadsMapping, titleThread, firstAsked, appendTurns, listReplayable, listThreads, markReplayable, nameThread, openThread, ownedThread, rememberChoice, remixThread, runInThreadWith, threadChoice, threadMessageRows, threadOwner, threadTitle } from "../../../threads.ts";
import { tracerFor } from "../../../trace.ts";
import { nextUtcMidnightIso, runsSince, secondsToUtcMidnight, utcDayStartText } from "../../../usage.ts";
import { agentRepository } from "../../authoring/agents/entities/agent.entity.ts";
import { AnsweredView } from "./dtos/answered-view.dto.ts";
import { CancelAskedView } from "./dtos/cancel-asked-view.dto.ts";
import { GuestAnsweredView } from "./dtos/guest-answered-view.dto.ts";
import { MessageView } from "./dtos/message-view.dto.ts";
import { RemixedView } from "./dtos/remixed-view.dto.ts";
import { WarmedView } from "./dtos/warmed-view.dto.ts";
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

  /* The first office run in a conversation pays the container's whole cold
   * start, which a person meets as half a minute on a one-word edit. Called
   * after forking a document template, so the container starts while they
   * are still typing. Idempotent: an existing container is simply reused. */
  warmOffice(id: string, owner: string): Reply {
    let row = findById(this.database, threadsMapping(), id);
    if (row == "" || row == "{}") {
      return NotFound("no conversation has that id");
    }
    let held = jsonText(row, "owner");
    if (held != "" && held != owner) {
      return NotFound("no conversation has that id");
    }
    let hasDocument = false;
    let files = listArtifacts(this.database, id);
    let i: int = 0;
    while (i < files.length) {
      if (binaryKind(files[i].kind) && files[i].kind != "image") {
        hasDocument = true;
      }
      i = i + 1;
    }
    let image = hasDocument ? scriptImageForEnv(this.database, "", "office") : "";
    if (image == "") {
      let cold: WarmedView = { warming: false };
      return OkJson(cold);
    }
    let up = envEnsure(this.database, {
      threadId: id, name: "office", image: image,
      network: true, serve: false, command: "", start: true, now: stamp(),
    });
    let v: WarmedView = { warming: up.ok };
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

  /* A thread opened on supplied context - the generalized form of what
   * from-story did when stories lived in this database. The caller (the
   * Discover reader, or anything else) sends the article text it wants the
   * conversation seeded with; this service no longer knows what a story is. */
  fromStory(body: string, owner: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"agentId\":\"a1\",\"title\":\"...\",\"context\":\"...\"}");
    }
    let agentId = jsonText(body, "agentId");
    let context = jsonUnescape(jsonText(body, "context"));
    let title = jsonUnescape(jsonText(body, "title"));
    if (agentId == "" || context == "") {
      return BadRequest("an agentId and a context are required");
    }
    if (!existsById(this.database, agentRepository(), agentId)) {
      return BadRequest("no agent " + agentId);
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

    let seed = [userTurn(context)];
    let wrote = appendTurns(this.database, id, seed, 0);
    if (wrote != "") {
      return BadRequest("the context could not be attached: " + wrote);
    }

    if (title != "") {
      // The view below reports this title as the thread name, so a name that
      // did not land makes the reply disagree with the row.
      let named = nameThread(this.database, id, title);
      if (named != "") {
        console.error("threads: the seeded conversation could not be named and will show untitled — " + named);
      }
    }

    let v: ThreadFromStoryView = {
      id: id, agentId: agentId, modelChoiceId: chosen, title: title,
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
    let asked: DbAssignment[] = [{ column: "cancel_asked", value: `${Date.now()}` }];
    let wrote = setOn(this.database, threadRepository(), { id: id, values: asked });
    if (!wrote.ok) {
      return BadRequest(wrote.error);
    }
    let v: CancelAskedView = { asked: true };
    return OkJson(v);
  }

  /** Name the conversation, on its own. The say() call may be told the
   *  caller is doing this, in which case the two run side by side and the
   *  answer is never held up by the naming. Idempotent: a thread that
   *  already has a name is left alone. */
  title(id: string, body: string, tags: string[]): Reply {
    ownedThread(this.database, id, tags);
    // The caller's own copy of what was asked, because the point of this
    // route is to run BESIDE the answer — and the turn it would otherwise be
    // read from is not written until that answer is finished. Without it the
    // naming works from an empty conversation and names it nothing.
    let said = jsonText(body, "text");
    if (said == "") {
      said = firstAsked(this.database, id);
    }
    if (said == "") {
      return BadRequest("nothing to name this from: send {\"text\":\"...\"} "
        + "or call this once the first message is stored");
    }
    let note = titleThread(this.database,
      { threadId: id, userText: said, master: this.master });
    return OkJson("{\"title\":" + JSON.stringify(threadTitle(this.database, id))
      + ",\"note\":" + JSON.stringify(note) + "}");
  }

  say(id: string, body: string, tags: string[]): Reply {
    let agentId = ownedThread(this.database, id, tags);
    // Before anything else: with the previous stop still on the row, the run
    // below would come straight back as "cancelled" and burn the turn.
    let unasked: DbAssignment[] = [{ column: "cancel_asked", value: "" }];
    let cleared = setOn(this.database, threadRepository(), { id: id, values: unasked });
    if (!cleared.ok) {
      return BadRequest("the last stop on this conversation could not be lifted, so a new "
        + "message would come back cancelled — " + cleared.error);
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
      if (used < 0) {
        return Respond(503, "{\"error\":\"the guest allowance could not be read\"}",
          "application/json");
      }
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
      titledElsewhere: jsonText(body, "titledElsewhere") == "true",
      mustSearch: jsonText(body, "searchOn") == "true",
    });
    let run = answered.run;
    let runId = recordRun(this.database, {
      agentId: agentId, threadId: id,
      owner: threadOwner(this.database, id),
      question: text, run: withNotes(run, answered.notes),
      modelChoiceId: answered.modelChoiceId, routeNote: answered.routeNote,
    });

    /* Queued, never flushed here: the collector upload took up to 27.9s on
     * prod against ~3s of generation, and it sat between the finished answer
     * and the reply carrying it. trace-outbox.ts says the rest. The id is
     * handed out on faith — the shipper retries until it lands or gives up
     * loudly, and a trace link that 404s for a minute is a better trade than
     * every reply waiting on telemetry. */
    let traced = "";
    if (tracing(tracer) && run.spans.length > 0) {
      let queued = enqueueTrace(this.database, tracerWithMoreSpans(tracer, run.spans));
      if (queued == "") {
        traced = traceId(tracer);
      } else {
        console.error("trace outbox: a trace could not be queued — " + queued);
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
    let spent = runsSince(this.database, guest, utcDayStartText(Date.now()));
    // Reported, not gated: the run has already happened by here, and a count
    // that cannot be read should not turn a good answer into an error.
    let left = GUEST_DAILY_RUNS - (spent < 0 ? GUEST_DAILY_RUNS : spent);
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

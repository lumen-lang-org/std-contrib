import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { ArtifactRow, TURN_SEQ_NONE, TurnArtifact } from "../../../artifacts.ts";
import { normalScope } from "../../../knowledge.ts";
import { OfficeRenderAsk } from "../../../office-render.ts";
import { ArtifactCreated } from "./dtos/artifact-created.dto.ts";
import { ArtifactPost } from "./dtos/artifact-post.dto.ts";
import { ArtifactRotated } from "./dtos/artifact-rotated.dto.ts";
import { ArtifactView } from "./dtos/artifact-view.dto.ts";
import { TemplatePost } from "./dtos/template-post.dto.ts";
import { TemplateStarted } from "./dtos/template-started.dto.ts";
import { TurnArtifactView } from "./dtos/turn-artifact-view.dto.ts";
import { ArtifactRepository } from "./artifact.repository.ts";
import { ARTIFACT_BODY_HELP, TEMPLATE_BODY_HELP, artifactPdfView, artifactVersionView, artifactView, noArtifact, turnArtifactView, turnFromQuery } from "./artifact.utils.ts";

export type Delivery = { absent: string, fault: string, document: string };

export function nothingThere(what: string): Delivery {
  return { absent: what, fault: "", document: "" };
}

export function declining(said: string): Delivery {
  return { absent: "", fault: said, document: "" };
}

export function delivered(document: string): Delivery {
  return { absent: "", fault: "", document: document };
}

export class ArtifactService {
  repository: ArtifactRepository;

  constructor(database: Db) {
    this.repository = new ArtifactRepository(database);
  }

  threadIsOwned(threadId: string, tags: string[]): bool {
    return this.repository.threadOwner(threadId, tags) != "";
  }

  /** Whether these files may be read. Wider than owning it: a conversation
   *  offered as a starting point is meant to be looked inside before it is
   *  taken, and files nobody may see make a prepared project read as empty. */
  threadIsReadable(threadId: string, tags: string[]): bool {
    return this.repository.threadReader(threadId, tags) != "";
  }

  atSlot(threadId: string, slot: int): ArtifactRow {
    if (slot < 0) {
      return noArtifact();
    }
    let rows = this.repository.listing(threadId);
    let i: int = 0;
    while (i < rows.length) {
      if (rows[i].slot == slot) {
        return rows[i];
      }
      i = i + 1;
    }
    return noArtifact();
  }

  hasSlot(threadId: string, slot: int): bool {
    return this.atSlot(threadId, slot).id != "";
  }

  listing(threadId: string): ArtifactView[] {
    let rows = this.repository.listing(threadId);
    let out: ArtifactView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      out.push(artifactView(rows[i]));
      i = i + 1;
    }
    return out;
  }

  one(threadId: string, slot: int): ArtifactView {
    return artifactView(this.atSlot(threadId, slot));
  }

  create(threadId: string, sent: string): Outcome {
    if (sent == "") {
      return refusing(ARTIFACT_BODY_HELP);
    }
    let body: ArtifactPost = JSON.parse<ArtifactPost>(sent);
    let written = this.repository.save({
      threadId: threadId, path: body.path, title: body.title,
      content: body.content, note: body.note, origin: "uploaded",
      mustCreate: false,
      turnSeq: TURN_SEQ_NONE, now: stamp(),
    });
    if (!written.ok) {
      return refusing(written.fault);
    }
    let view: ArtifactCreated = {
      slot: written.slot,
      path: normalScope(body.path),
      version: written.version,
      previewToken: written.previewToken,
    };
    return produced(JSON.stringify(view));
  }

  fromTemplate(threadId: string, sent: string): Delivery {
    if (sent == "") {
      return declining(TEMPLATE_BODY_HELP);
    }
    let asked: TemplatePost = JSON.parse<TemplatePost>(sent);
    let templateId = asked.templateId;
    if (templateId == "") {
      return declining(TEMPLATE_BODY_HELP);
    }
    let held = this.repository.template(templateId);
    if (held == "") {
      return nothingThere("template " + templateId);
    }
    let template: TemplateRow = JSON.parse<TemplateRow>(held);
    if (template.visibility != "public") {
      return nothingThere("template " + templateId);
    }

    let listed = this.repository.templateFiles(templateId);
    let files: TemplateFileRow[] = listed == "" ? [] : JSON.parse<TemplateFileRow[]>(listed);
    let wrote: string[] = [];
    let refused: string[] = [];
    let i: int = 0;
    while (i < files.length) {
      let put = this.repository.save({
        threadId: threadId, path: files[i].path, title: files[i].title,
        content: files[i].body, note: "started from template " + template.label,
        origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: stamp(),
      });
      if (put.ok) {
        wrote.push(normalScope(files[i].path));
      } else {
        refused.push(files[i].path + ": " + put.fault);
      }
      i = i + 1;
    }
    let view: TemplateStarted = {
      template: template.label,
      skillName: template.skillName,
      wrote: wrote,
      refused: refused,
    };
    return delivered(JSON.stringify(view));
  }

  byTurn(threadId: string, turn: string): TurnArtifactView[] {
    let rows: TurnArtifact[] = [];
    if (turn == "") {
      rows = this.repository.everyTurn(threadId);
    } else {
      rows = this.repository.oneTurn(threadId, turnFromQuery(turn));
    }
    let out: TurnArtifactView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      out.push(turnArtifactView(rows[i]));
      i = i + 1;
    }
    return out;
  }

  version(threadId: string, slot: int, wanted: int): string {
    let artifact = this.atSlot(threadId, slot);
    let row = this.repository.version(artifact.id, wanted);
    if (row.id == "") {
      return "";
    }
    return JSON.stringify(artifactVersionView(artifact, row));
  }

  pdf(threadId: string, slot: int, asked: int): Delivery {
    let artifact = this.atSlot(threadId, slot);
    let version = asked > 0 ? asked : artifact.currentVersion;
    let row = this.repository.version(artifact.id, version);
    if (row.id == "") {
      return nothingThere("version " + `${version}`);
    }

    let ask: OfficeRenderAsk = {
      artifactId: artifact.id, version: version,
      path: artifact.path, body: row.body, now: stamp(),
    };
    let made = this.repository.render(ask);
    if (!made.ok) {
      return declining(made.fault);
    }
    return delivered(JSON.stringify(artifactPdfView(artifact, version, made)));
  }

  rotate(threadId: string, slot: int): Outcome {
    let artifact = this.atSlot(threadId, slot);
    let now = stamp();
    let mine = this.repository.ofThread(threadId);
    let fresh = "";
    let i: int = 0;
    while (i < mine.length) {
      let each: ArtifactRow = JSON.parse<ArtifactRow>(mine[i]);
      let token = crypto.randomUUID();
      if (each.id == artifact.id) {
        fresh = token;
      }
      let turned = this.repository.setPreviewToken(each.id, token, now);
      if (!turned.ok) {
        return refusing("the links could not be replaced; try again");
      }
      i = i + 1;
    }
    let view: ArtifactRotated = {
      slot: artifact.slot,
      previewToken: fresh,
      replaced: mine.length,
    };
    return produced(JSON.stringify(view));
  }

  forget(threadId: string, slot: int): Outcome {
    let artifact = this.atSlot(threadId, slot);
    let fault = this.repository.forget(threadId, artifact.path);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }
}

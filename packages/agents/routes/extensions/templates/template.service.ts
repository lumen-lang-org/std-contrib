import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { OfficeRenderAsk, officeRender } from "../../../office-render.ts";
import { createFault, jsonId } from "../../../payload.ts";
import { jsonText } from "../../../scan.ts";
import { TemplateBody } from "./dtos/template-body.dto.ts";
import { TemplateFileBody } from "./dtos/template-file-body.dto.ts";
import { TemplatePdfView } from "./dtos/template-pdf-view.dto.ts";
import { TemplateStartedView } from "./dtos/template-started-view.dto.ts";
import { TemplateRepository } from "./template.repository.ts";
import { renderableFileIndex, templateReply, templateRequest, templateStartCmd } from "./template.utils.ts";

export class TemplateService {
  repository: TemplateRepository;

  constructor(database: Db) {
    this.repository = new TemplateRepository(database);
  }

  listing(kind: string): string {
    if (kind != "") {
      return this.repository.publicListingOfKind(kind);
    }
    return this.repository.publicListing();
  }

  one(id: string): string {
    return this.repository.one(id);
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  fileExists(fileId: string): bool {
    return this.repository.fileExists(fileId);
  }

  files(id: string): string {
    return this.repository.filesOf(id);
  }

  isPublic(id: string): bool {
    let document = this.repository.one(id);
    if (document == "") {
      return false;
    }
    let template: TemplateBody = JSON.parse<TemplateBody>(document);
    return template.visibility == "public";
  }

  create(document: string): Outcome {
    let fault = createFault(this.repository.database, this.repository.templates, document);
    if (fault != "") {
      return refusing(fault);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(jsonId(document)));
  }

  update(id: string, document: string): Outcome {
    if (jsonId(document) != id) {
      return refusing("the id in the body must match the path");
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  forget(id: string): Outcome {
    let fault = this.repository.forget(id);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }

  addFile(id: string, document: string): Outcome {
    if (jsonText(document, "templateId") != id) {
      return refusing("the templateId in the body must match the path");
    }
    let written = this.repository.saveFile(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.file(jsonId(document)));
  }

  updateFile(fileId: string, document: string): Outcome {
    if (jsonId(document) != fileId) {
      return refusing("the id in the body must match the path");
    }
    let written = this.repository.saveFile(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.file(fileId));
  }

  forgetFile(fileId: string): Outcome {
    let fault = this.repository.forgetFile(fileId);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }

  pdf(id: string): Outcome {
    let template: TemplateBody = JSON.parse<TemplateBody>(this.repository.one(id));
    let listed = this.repository.fileRowsOf(id);
    let files: TemplateFileBody[] = [];
    if (listed != "") {
      files = JSON.parse<TemplateFileBody[]>(listed);
    }
    let at = renderableFileIndex(files);
    if (at < 0) {
      return refusing("template " + template.label + " holds no document a PDF can be made of");
    }
    let ask: OfficeRenderAsk = {
      artifactId: "tpl:" + files[at].id, version: files[at].body.length,
      path: files[at].path, body: files[at].body, now: stamp(),
    };
    let made = officeRender(this.repository.database, ask);
    if (!made.ok) {
      return refusing(made.fault);
    }
    let view: TemplatePdfView = { template: template.id, path: files[at].path,
      cached: made.cached, pdf: made.body };
    return produced(JSON.stringify(view));
  }

  /** The conversation a starting point actually is.
   *
   *  A starting point used to be this row: an image and two commands, run
   *  afresh for whoever clicked it. It is a conversation now — someone asked
   *  for a React app, something built one, and the result is offered for other
   *  people to fork. This prepares that conversation: the thread, the
   *  environment, the command that generates the project once and serves it
   *  every time, and the transcript those two things came out of. What it
   *  generates becomes artifacts on the next workspace sweep, so the
   *  conversation ends up owning its own source, and a fork of it carries the
   *  files, the transcript and the running server together.
   *
   *  This row's remaining job is to seed that conversation once. Nobody reaches
   *  it from the console. */
  prepare(id: string, owner: string): Outcome {
    let t = this.repository.one(id);
    if (t == "" || t == "{}") {
      return refusing("no template has that id");
    }
    let row: TemplateBody = JSON.parse<TemplateBody>(t);
    if (row.kind != "project") {
      return refusing("\"" + row.label + "\" is not a project starting point");
    }
    let command = templateStartCmd(row.bootstrap ?? "", row.serve ?? "");
    if (command == "" || (row.image ?? "") == "") {
      return refusing("\"" + row.label + "\" has no image or nothing to serve");
    }
    let made = this.repository.startThread(owner, row.label, stamp());
    if (made == "") {
      return refusing("the conversation could not be started");
    }
    let up = this.repository.serveProject(made, row.image ?? "", command, stamp());
    if (!up.ok) {
      return refusing(up.fault);
    }
    // The request first, because a conversation that opens with an answer to
    // nothing reads as a machine talking to itself — and because this one was
    // really asked: it is what the bootstrap command was written to do.
    //
    // The reply names no address. A fork carries this transcript, and its
    // server answers on a hostname of its own, so a URL written here would be
    // wrong for everyone who takes it.
    let greeted = this.repository.greet(made, templateRequest(row), templateReply(row));
    if (greeted != "") {
      return refusing(greeted);
    }
    let view: TemplateStartedView = {
      threadId: made,
      host: this.repository.hostFor(up.slug),
      slug: up.slug,
      building: row.bootstrap != "",
    };
    return produced(JSON.stringify(view));
  }
}

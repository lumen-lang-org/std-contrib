import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { OfficeRenderAsk, officeRender } from "../../office-render.ts";
import { createFault, jsonId } from "../../payload.ts";
import { TemplateBody } from "./dtos/template-body.dto.ts";
import { TemplateFileBody } from "./dtos/template-file-body.dto.ts";
import { TemplatePdfView } from "./dtos/template-pdf-view.dto.ts";
import { TemplateRepository } from "./template.repository.ts";
import { renderableFileIndex } from "./template.utils.ts";

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

  addFile(document: string): Outcome {
    let written = this.repository.saveFile(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.file(jsonId(document)));
  }

  updateFile(fileId: string, document: string): Outcome {
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
}

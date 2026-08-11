import { Db } from "../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../plume/plume.ts";
import { templateFileRepository } from "./entities/template-file.entity.ts";
import { templateRepository } from "./entities/template.entity.ts";

export class TemplateRepository {
  database: Db;
  templates: DbRepository;
  files: DbRepository;

  constructor(database: Db) {
    this.database = database;
    this.templates = templateRepository();
    this.files = templateFileRepository();
  }

  publicListing(): string {
    let keys: DbOrder[] = [{ column: "featured_rank" }, { column: "label" }];
    return listOrdered(this.database, this.templates, {
      where: "visibility = 'public'",
      order: keys,
    });
  }

  publicListingOfKind(kind: string): string {
    let keys: DbOrder[] = [{ column: "featured_rank" }, { column: "label" }];
    return listOrdered(this.database, this.templates, {
      where: "visibility = 'public' AND kind = " + placeholderAt(this.database, 1),
      args: [kind],
      order: keys,
    });
  }

  one(id: string): string {
    return findById(this.database, this.templates, id);
  }

  exists(id: string): bool {
    return existsById(this.database, this.templates, id);
  }

  save(document: string): DbResult {
    return persist(this.database, this.templates, document);
  }

  file(fileId: string): string {
    return findById(this.database, this.files, fileId);
  }

  fileExists(fileId: string): bool {
    return existsById(this.database, this.files, fileId);
  }

  saveFile(document: string): DbResult {
    return persist(this.database, this.files, document);
  }

  filesOf(id: string): string {
    let keys: DbOrder[] = [{ column: "path" }];
    return listOrdered(this.database, this.files, {
      where: "template_id = " + placeholderAt(this.database, 1),
      args: [id],
      order: keys,
    });
  }

  fileRowsOf(id: string): string {
    return listWhere(this.database, this.files,
                     "template_id = " + placeholderAt(this.database, 1), [id]);
  }

  forgetFile(fileId: string): string {
    let gone = deleteById(this.database, this.files, fileId);
    if (!gone.ok) {
      return gone.error;
    }
    return "";
  }

  forget(id: string): string {
    let steps: DbResult[] = [
      deleteWhere(this.database, this.files,
                  "template_id = " + placeholderAt(this.database, 1), [id]),
      deleteById(this.database, this.templates, id),
    ];
    let i: int = 0;
    while (i < steps.length) {
      if (!steps[i].ok) {
        return steps[i].error;
      }
      i = i + 1;
    }
    return "";
  }
}

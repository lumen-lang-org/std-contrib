import { Db } from "../../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { createFault, jsonId } from "../../../payload.ts";
import { SkillBody } from "./dtos/skill-body.dto.ts";
import { SkillFileBody } from "./dtos/skill-file-body.dto.ts";
import { SkillRepository } from "./skill.repository.ts";
import { fileCopyOf, localCopyOf, skillFault, skillFileFault } from "./skill.utils.ts";

export class SkillService {
  repository: SkillRepository;

  constructor(database: Db) {
    this.repository = new SkillRepository(database);
  }

  listing(featuredOnly: bool): string {
    if (featuredOnly) {
      return this.repository.featured();
    }
    return this.repository.listing();
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

  create(document: string): Outcome {
    let fault = createFault(this.repository.database, this.repository.skills, document);
    if (fault != "") {
      return refusing(fault);
    }
    let row: SkillBody = JSON.parse<SkillBody>(document);
    let named = skillFault(row);
    if (named != "") {
      return refusing(named);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(jsonId(document)));
  }

  update(id: string, document: string): Outcome {
    let row: SkillBody = JSON.parse<SkillBody>(document);
    if (row.id != id) {
      return refusing("the id in the body must match the path");
    }
    let before: SkillBody = JSON.parse<SkillBody>(this.repository.one(id));
    if (before.source == "repo") {
      return refusing("this skill comes from " + before.sourceUrl
        + " and is edited there; copy it to a local skill to change it here");
    }
    let named = skillFault(row);
    if (named != "") {
      return refusing(named);
    }
    let written = this.repository.save(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(id));
  }

  copyLocal(id: string): Outcome {
    let from: SkillBody = JSON.parse<SkillBody>(this.repository.one(id));
    if (from.source != "repo") {
      return refusing("this skill is already yours to edit — copying it would only make a second name for the same instructions");
    }
    let base = from.skillName + "-local";
    let name = base;
    let n: int = 2;
    // A name is only free if the count says so. Unreadable, the loop would
    // stop on its first turn and hand back a name something else may hold.
    let taken = this.repository.named(name);
    while (taken > 0) {
      name = base + "-" + `${n}`;
      n = n + 1;
      taken = this.repository.named(name);
    }
    if (taken < 0) {
      return refusing("could not check whether \"" + name + "\" is already taken");
    }
    let made = localCopyOf(from, crypto.randomUUID(), name);
    let written = this.repository.save(JSON.stringify(made));
    if (!written.ok) {
      return refusing(written.error);
    }
    let listed = this.repository.fileRowsOf(from.id);
    let files: SkillFileBody[] = listed == "" || listed == "[]"
      ? [] : JSON.parse<SkillFileBody[]>(listed);
    let f: int = 0;
    while (f < files.length) {
      let copy = fileCopyOf(files[f], crypto.randomUUID(), made.id);
      let fileWritten = this.repository.saveFile(JSON.stringify(copy));
      if (!fileWritten.ok) {
        return refusing(fileWritten.error);
      }
      f = f + 1;
    }
    return produced(this.repository.one(made.id));
  }

  forget(id: string): Outcome {
    let fault = this.repository.forget(id);
    if (fault != "") {
      return refusing(fault);
    }
    return produced("");
  }

  addFile(id: string, document: string): Outcome {
    let fault = createFault(this.repository.database, this.repository.files, document);
    if (fault != "") {
      return refusing(fault);
    }
    let row: SkillFileBody = JSON.parse<SkillFileBody>(document);
    if (row.skillId != id) {
      return refusing("the skillId in the body must match the path");
    }
    let named = skillFileFault(row);
    if (named != "") {
      return refusing(named);
    }
    let written = this.repository.saveFile(document);
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.file(jsonId(document)));
  }

  updateFile(id: string, fileId: string, document: string): Outcome {
    let row: SkillFileBody = JSON.parse<SkillFileBody>(document);
    if (row.id != fileId) {
      return refusing("the id in the body must match the path");
    }
    if (row.skillId != id) {
      return refusing("the skillId in the body must match the path");
    }
    let named = skillFileFault(row);
    if (named != "") {
      return refusing(named);
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
}

import { Db } from "../../../../plume/driver.ts";
import { jsonText } from "../../../scan.ts";
import { Outcome, produced, refusing } from "../../../../rest/server.ts";
import { stamp } from "../../../api-core.ts";
import { holdsOwner } from "../../../owner.ts";
import { ProjectRow, emptyProject } from "../../../projects.ts";
import { FilesThreadView } from "./dtos/files-thread-view.dto.ts";
import { ProjectRepository } from "./project.repository.ts";

export class ProjectService {
  repository: ProjectRepository;

  constructor(database: Db) {
    this.repository = new ProjectRepository(database);
  }

  listing(owner: string): string {
    return this.repository.listing(owner);
  }

  owned(id: string, tags: string[]): ProjectRow {
    let document = this.repository.one(id);
    if (document == "") {
      return emptyProject();
    }
    let row: ProjectRow = JSON.parse<ProjectRow>(document);
    if (!holdsOwner(tags, row.owner)) {
      return emptyProject();
    }
    return row;
  }

  owns(id: string, tags: string[]): bool {
    return this.owned(id, tags).id != "";
  }

  create(owner: string, body: string): Outcome {
    if (body == "") {
      return refusing("a body is required: {\"name\":\"...\",\"instructions\":\"...\"}");
    }
    let name = jsonText(body, "name");
    if (name == "") {
      return refusing("a project needs a name");
    }
    let row: ProjectRow = {
      id: crypto.randomUUID(),
      owner: owner,
      name: name,
      instructions: jsonText(body, "instructions"),
      filesThreadId: "",
      createdAt: stamp(),
    };
    let written = this.repository.save(JSON.stringify(row));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(row.id));
  }

  update(id: string, tags: string[], body: string): Outcome {
    let mine = this.owned(id, tags);
    if (body == "") {
      return refusing("a body is required");
    }
    let name = jsonText(body, "name");
    let edited: ProjectRow = {
      id: mine.id, owner: mine.owner,
      name: name == "" ? mine.name : name,
      instructions: jsonText(body, "instructions"),
      filesThreadId: mine.filesThreadId,
      createdAt: mine.createdAt,
    };
    let written = this.repository.save(JSON.stringify(edited));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(this.repository.one(mine.id));
  }

  forget(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    let gone = this.repository.remove(mine.id);
    if (!gone.ok) {
      return refusing(gone.error);
    }
    return produced("");
  }

  filesThread(id: string, tags: string[]): Outcome {
    let mine = this.owned(id, tags);
    if (mine.filesThreadId != "") {
      if (this.repository.filesThreadExists(mine.filesThreadId)) {
        let held: FilesThreadView = { threadId: mine.filesThreadId };
        return produced(JSON.stringify(held));
      }
    }
    let opened = this.repository.openFilesThread(mine.owner, stamp());
    if (opened == "") {
      return refusing("the files thread could not be opened");
    }
    let stamped = this.repository.markFilesThreadRoute(opened);
    if (stamped != "") {
      return refusing(stamped);
    }
    let noted = this.repository.noteFilesThread(mine.id, opened);
    if (noted != "") {
      return refusing(noted);
    }
    let view: FilesThreadView = { threadId: opened };
    return produced(JSON.stringify(view));
  }
}

import { Db } from "../../../../plume/driver.ts";
import { DbOrder, DbRepository, DbResult, deleteById, deleteWhere, executeWith, existsById, findById, listOrdered, listWhere, persist, placeholderAt } from "../../../../plume/plume.ts";
import { templateFileRepository } from "./entities/template-file.entity.ts";
import { templateRepository } from "./entities/template.entity.ts";
import { EnvEnsure, EnvEnsured, envEnsure } from "../../../environments.ts";
import { envHostFor } from "../../../env-grants.ts";
import { ThreadRow, appendTurns, markReplayable } from "../../../threads.ts";
import { TURN_SEQ_NONE, putArtifact } from "../../../artifacts.ts";
import { TemplateFileBody } from "./dtos/template-file-body.dto.ts";
import { threadRepository } from "../../conversations/threads/entities/thread.entity.ts";
import { Turn, ToolCall, assistantTurn, userTurn } from "../../../provider.ts";

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

  /** A conversation of this owner's, named after the starting point. */
  startThread(owner: string, title: string, now: string): string {
    let id = crypto.randomUUID();
    let row: ThreadRow = {
      id: id, agentId: "a-assistant", owner: owner, modelChoiceId: "",
      routeKey: "", title: title, replayable: false, projectId: "",
      createdAt: now,
    };
    let written = persist(this.database, threadRepository(), JSON.stringify(row));
    if (!written.ok) {
      return "";
    }
    return id;
  }

  serveProject(threadId: string, image: string, command: string, now: string): EnvEnsured {
    let e: EnvEnsure = {
      threadId: threadId, name: "web", image: image,
      network: true, serve: true, command: command, start: true, agent: false, now: now,
    };
    return envEnsure(this.database, e);
  }

  hostFor(slug: string): string {
    return envHostFor(slug);
  }

  /** The template's own files, laid into a conversation as artifacts. The
   *  same write the console's "start from" used to make in an empty thread;
   *  now it happens once, when the starting point is prepared. */
  layFiles(threadId: string, label: string, files: TemplateFileBody[], now: string): string[] {
    let wrote: string[] = [];
    let i: int = 0;
    while (i < files.length) {
      let put = putArtifact(this.database, {
        threadId: threadId, path: files[i].path, title: files[i].title,
        content: files[i].body, note: "started from template " + label,
        origin: "uploaded", mustCreate: false, turnSeq: TURN_SEQ_NONE, now: now,
      });
      if (put.ok) {
        wrote.push(files[i].path);
      }
      i = i + 1;
    }
    return wrote;
  }

  /** A prepared conversation is a starting point: it shows in the list a fork
   *  is taken from. */
  offer(threadId: string): string {
    return markReplayable(this.database, threadId, true);
  }

  /** Which conversation this template prepared, so a card can open it. */
  notePrepared(templateId: string, threadId: string): string {
    let wrote = executeWith(this.database,
      "UPDATE templates SET prepared_thread = " + placeholderAt(this.database, 1)
      + " WHERE id = " + placeholderAt(this.database, 2),
      [threadId, templateId]);
    if (wrote.ok) {
      return "";
    }
    return wrote.error;
  }

  /** The transcript a prepared conversation opens with: the request, then the
   *  reply.
   *
   *  A user turn here is a real one — it is the request this starting point was
   *  built to answer, written by whoever prepared it. What would be dishonest
   *  is putting it in somebody's *fork*, and a fork copies rather than invents,
   *  so the words stay attached to the person who wrote them. */
  greet(threadId: string, asked: string, said: string): string {
    let none: ToolCall[] = [];
    let turns: Turn[] = [userTurn(asked), assistantTurn(said, none)];
    return appendTurns(this.database, threadId, turns, 0);
  }
}

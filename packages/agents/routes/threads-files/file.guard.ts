import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { pgOnly } from "../../guards.ts";
import { FileService } from "./file.service.ts";

export function corpusIsPostgres(files: FileService): Guarded {
  let database = files.repository.database;
  return pgOnly(database, "the corpus needs PostgreSQL (pgvector); this runs on " + database.name);
}

export function threadOwned(files: FileService, request: Request): Guarded {
  let id = param(request, "id");
  if (!files.threadIsOwned(id, callerTags(request))) {
    return reject(NotFound("thread " + id));
  }
  return resolve();
}

export function fileNamed(files: FileService, request: Request): Guarded {
  let name = param(request, "name");
  if (!files.has(param(request, "id"), name)) {
    return reject(NotFound("file " + name));
  }
  return resolve();
}

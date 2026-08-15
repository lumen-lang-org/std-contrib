import { Guarded, NotFound, Request, param, reject, resolve } from "../../../../rest/server.ts";
import { callerTags } from "../../../api-core.ts";
import { ownedThread, readableThread } from "../../../threads.ts";
import { ThreadService } from "./thread.service.ts";

/** Someone else's conversation is absent, not forbidden: a 404 says nothing
 *  about whether the id exists. */
export function threadOwned(threads: ThreadService, request: Request): Guarded {
  let id = param(request, "id");
  if (ownedThread(threads.database, id, callerTags(request)) == "") {
    return reject(NotFound("thread " + id));
  }
  return resolve();
}

/** Wider than threadOwned: a conversation offered as a starting point can be
 *  read by anyone, which is what makes it offerable. */
export function threadReadable(threads: ThreadService, request: Request): Guarded {
  let id = param(request, "id");
  if (readableThread(threads.database, id, callerTags(request)) == "") {
    return reject(NotFound("thread " + id));
  }
  return resolve();
}

import { Guarded, Request, NotFound, param, resolve, reject } from "../../../rest/server.ts";
import { DiscoverService } from "./discover.service.ts";

export function storyStillOnItsFeed(discover: DiscoverService, request: Request): Guarded {
  let id = param(request, "id");
  if (!discover.hasStory(id)) {
    return reject(NotFound("story " + id + " has rolled off its feed"));
  }
  return resolve();
}

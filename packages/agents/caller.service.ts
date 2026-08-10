import { Request, header } from "../rest/server.ts";
import { UNKNOWN_TAG, owningTag, tagsFromHeader, trustsProxyAuth } from "./owner.ts";

export class CallerService {
  trusted: bool;

  constructor(trusted: bool) {
    this.trusted = trusted;
  }

  tags(req: Request): string[] {
    return tagsFromHeader(this.trusted, header(req, "x-user"));
  }

  owner(req: Request): string {
    return owningTag(this.tags(req));
  }

  unreadable(req: Request): bool {
    let tags = this.tags(req);
    return tags.length == 1 && tags[0] == UNKNOWN_TAG;
  }
}

export function caller(): CallerService {
  return new CallerService(trustsProxyAuth());
}

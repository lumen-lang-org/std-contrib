import { Request, header } from "../rest/server.ts";
import { UNKNOWN_TAG, owningTag, tagsFromHeader, trustsProxyAuth } from "./owner.ts";

export class CallerService {
  trusted: bool;

  constructor(trusted: bool) {
    this.trusted = trusted;
  }

  tags(request: Request): string[] {
    return tagsFromHeader(this.trusted, header(request, "x-user"));
  }

  owner(request: Request): string {
    return owningTag(this.tags(request));
  }

  unreadable(request: Request): bool {
    let tags = this.tags(request);
    return tags.length == 1 && tags[0] == UNKNOWN_TAG;
  }
}

export function caller(): CallerService {
  return new CallerService(trustsProxyAuth());
}

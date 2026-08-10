import { Request, header } from "../rest/server.ts";
import { UNKNOWN_TAG, owningTag, tagsFromHeader, trustsProxyAuth } from "./owner.ts";

// Who the caller is. Not a lookup — a decision: the x-user header only means
// anything when the proxy setting it is trusted, and a handler that read the
// header without that rule would let anyone name themselves any owner.
//
// The trust flag is a field rather than an env read per call, so a test can
// build an untrusted one and see what an untrusted deployment sees.
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

  // A header that is set but cannot be read is not the same as no header: it
  // means the proxy is speaking and we cannot understand it.
  unreadable(req: Request): bool {
    let tags = this.tags(req);
    return tags.length == 1 && tags[0] == UNKNOWN_TAG;
  }
}

export function caller(): CallerService {
  return new CallerService(trustsProxyAuth());
}

import { Request, queryParam } from "../../../rest/server.ts";

export type PlaygroundCall = {
  q: string,
  k: string,
  hybrid: string,
  maxChars: string,
  site: string,
  lang: string,
  country: string,
};

export function playgroundCallOf(request: Request): PlaygroundCall {
  let call: PlaygroundCall = {
    q: queryParam(request, "q", ""),
    k: queryParam(request, "k", ""),
    hybrid: queryParam(request, "hybrid", ""),
    maxChars: queryParam(request, "max_chars", ""),
    site: queryParam(request, "site", ""),
    lang: queryParam(request, "lang", ""),
    country: queryParam(request, "country", ""),
  };
  return call;
}

import { Request, header, queryParam } from "../../../rest/server.ts";
import { presentedKey } from "../../search-gateway.ts";

export type ForwardCall = {
  secret: string,
  q: string,
  k: string,
  hybrid: string,
  maxChars: string,
  site: string,
  lang: string,
  country: string,
};

export function forwardCallOf(request: Request): ForwardCall {
  let call: ForwardCall = {
    secret: presentedKey(header(request, "authorization"), header(request, "x-api-key")),
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

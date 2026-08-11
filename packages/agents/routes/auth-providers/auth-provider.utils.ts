import { AuthProviderAsk } from "./dtos/auth-provider-ask.dto.ts";

export function kindOrDefault(kind: string): string {
  return kind == "" ? "oidc" : kind;
}

export function authProviderFault(ask: AuthProviderAsk): string {
  let kind = kindOrDefault(ask.kind);
  if (kind == "oidc" && !ask.issuer.startsWith("https://")) {
    return "the issuer is an https address whose /.well-known/openid-configuration describes the provider";
  }
  return "";
}

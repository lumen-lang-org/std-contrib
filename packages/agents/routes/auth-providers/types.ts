export type AuthProviderView = {
  id: string,
  label: string,
  kind: string,
  issuer: string,
  clientId: string,
  scopes: string,
  enabled: bool,
  configured: bool,
};

export type AuthProviderResolvedView = {
  id: string,
  label: string,
  kind: string,
  issuer: string,
  clientId: string,
  clientSecret: string,
  scopes: string,
};

export type AuthProviderSecretStored = { configured: bool };

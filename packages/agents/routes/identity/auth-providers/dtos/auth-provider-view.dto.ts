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

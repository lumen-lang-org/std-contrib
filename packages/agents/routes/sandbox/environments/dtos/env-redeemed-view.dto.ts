export type EnvRedeemedView = {
  ok: bool,
  /** address:port on the private side. The gateway proxies here and the
   *  reader never sees it. */
  upstream: string,
  owner: string,
  fault: string,
};

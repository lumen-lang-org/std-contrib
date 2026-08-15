/** A row of the model menu, as this route reads and writes it.
 *
 *  A choice points at either a config or a router, never both; which one is
 *  meant is what `kind` says. */
export type ModelChoiceBody = {
  id: string,
  label: string,
  description: string,
  kind: string,
  configId: string,
  routerId: string,
  tier: string,
  enabled: bool,
  rank: int,
};

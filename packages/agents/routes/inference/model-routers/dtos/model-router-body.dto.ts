/** A router as this route reads and writes it.
 *
 *  candidatesJson is the stored column: a JSON array of {key, configId, when}.
 *  Over the wire it is called "candidates" and is a real array, which is what
 *  routerJson and bodyCandidates translate between. */
export type ModelRouterBody = {
  id: string,
  label: string,
  routerConfigId: string,
  candidatesJson: string,
  fallbackConfigId: string,
  routeEvery: string,
  escalateOnly: bool,
  enabled: bool,
};

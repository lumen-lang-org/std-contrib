/** One candidate, reduced to the three members a router routes on. Anything
 *  else a caller sent alongside is dropped rather than stored. */
export type CandidateView = {
  key: string,
  configId: string,
  when: string,
};

export type ReplayableThreadView = {
  id: string,
  agentId: string,
  createdAt: string,
  title: string,
  replayable: bool,
  /** What the conversation opens with, and whether taking it gives you
   *  something running. A starting point is chosen from a card, and a card
   *  with only a title says nothing about what is behind it. */
  blurb: string,
  runs: bool,
};

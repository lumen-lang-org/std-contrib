export type TemplateBody = {
  id: string,
  label: string,
  description: string,
  kind: string,
  skillName: string,
  visibility: string,
  featuredRank: int,
  /** A project starting point: the image it runs in, the command that
   *  generates it once, and the command that serves it. */
  image?: string,
  bootstrap?: string,
  serve?: string,
  /** The first message of the conversation this prepares. */
  request?: string,
  /** The conversation prepared from it. A card forks that one. */
  preparedThread?: string,
};

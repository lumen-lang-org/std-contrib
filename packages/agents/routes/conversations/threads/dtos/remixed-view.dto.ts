export type RemixedView = {
  id: string,
  files: int,
  turns: int,
  /** Whether this fork came up with a server of its own, so the console knows
   *  to open the panel on it rather than leaving the reader to find it. */
  serves: bool,
};

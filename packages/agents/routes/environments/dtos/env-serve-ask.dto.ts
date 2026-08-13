export type EnvServeAsk = {
  image?: string,
  /** What to run inside to make it serve. Kept, and run again whenever the
   *  container comes back. */
  command?: string,
};

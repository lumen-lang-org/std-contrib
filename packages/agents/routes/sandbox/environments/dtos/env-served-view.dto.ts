export type EnvServedView = {
  slug: string,
  host: string,
  created: bool,
  /** False while it is still installing, which is not a failure and should not
   *  be shown as one. */
  answering: bool,
};

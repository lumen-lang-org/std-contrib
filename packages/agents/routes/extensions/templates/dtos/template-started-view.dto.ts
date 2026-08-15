export type TemplateStartedView = {
  threadId: string,
  /** The name the project answers to once it is up. Empty while it is still
   *  generating, which for Angular is minutes rather than seconds. */
  host: string,
  slug: string,
  building: bool,
};

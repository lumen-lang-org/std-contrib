/** What a registration hands back: the three ids it created.
 *
 *  `modelChoiceId` is the one that matters to a caller — a workflow binds that,
 *  not the model and not the config. */
export type ModelRegistered = {
  modelId: string,
  modelConfigId: string,
  modelChoiceId: string,
};

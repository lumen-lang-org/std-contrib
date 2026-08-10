// The shapes the agents routes read and write.

export type ServerLink = { serverId: string };

export type SkillLink = { skillId: string };

export type ChildLink = { childId: string };

// `RunBody` serves `POST /agents/:id/run` only, which takes no `modelChoiceId`
// — it has no conversation and no picker in front of it. There is deliberately
// no record for either thread door: both take an optional `modelChoiceId`, and
// a record type refuses a document carrying a key it does not declare, so they
// read their members instead. See `askedChoice`.
export type RunBody = { text: string };

export type ScopeGrant = { scope: string };

export type RetrievalSetup = { embeddingModelId: string, topK: int, maxDistance: number, enabled: bool };

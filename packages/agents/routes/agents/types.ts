export type ServerLink = { serverId: string };

export type SkillLink = { skillId: string };

export type ChildLink = { childId: string };

export type RunBody = { text: string };

export type ScopeGrant = { scope: string };

export type RetrievalSetup = { embeddingModelId: string, topK: int, maxDistance: number, enabled: bool };

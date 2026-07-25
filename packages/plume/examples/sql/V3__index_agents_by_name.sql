-- Agents are looked up by name often enough to index it.
CREATE INDEX IF NOT EXISTS mf_agents_by_name ON mf_agents (agent_name)

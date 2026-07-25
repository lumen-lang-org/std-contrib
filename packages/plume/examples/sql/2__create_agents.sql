-- An agent, and the team it reports to.
--
-- The foreign key is spelled out here rather than derived, because this is the
-- schema's own statement of itself. plume can generate the same clause from a
-- relation (createTableSqlWithKeys) when you would rather not repeat it.
CREATE TABLE IF NOT EXISTS mf_agents (
  id          text PRIMARY KEY,
  agent_name  text NOT NULL,
  max_steps   int  NOT NULL,
  team_id     text NOT NULL,
  FOREIGN KEY (team_id) REFERENCES mf_teams (id)
)

-- A team an agent belongs to.
--
-- Written as SQL, in a .sql file, so it is reviewable by anyone who reads SQL
-- and not Lumen — and embedded into the binary at compile time, so nothing
-- ships beside it.
CREATE TABLE IF NOT EXISTS mf_teams (
  id         text PRIMARY KEY,
  team_name  text NOT NULL
)

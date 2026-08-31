import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, countWhere, findById, persist, createTableSql } from "../plume/plume.ts";
import { SkillRow, skillsMapping } from "./schema.ts";
import { seedOfficeSkills, OFFICE_SKILL_IDS } from "./office-skills.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_office_skills_test.db" };
  connectDatabase(database, cfg);
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, createTableSql(database, skillsMapping()));
}

test("seeding an empty database inserts the five office skills as public local rows", () => {
  fresh();
  expect(countWhere(database, skillsMapping(), "", []) == 0);
  seedOfficeSkills(database);
  expect(countWhere(database, skillsMapping(), "", []) == 5);
  expect(OFFICE_SKILL_IDS.length == 5);
  let i: int = 0;
  while (i < OFFICE_SKILL_IDS.length) {
    let held = findById(database, skillsMapping(), OFFICE_SKILL_IDS[i]);
    expect(held != "");
    let row: SkillRow = JSON.parse<SkillRow>(held);
    expect(row.visibility == "public");
    expect(row.source == "local");
    expect(row.sourceUrl == "");
    expect(row.body != "");
    i = i + 1;
  }
});

test("the fill-doc body documents the bracketed placeholder key verbatim", () => {
  fresh();
  seedOfficeSkills(database);
  let row: SkillRow = JSON.parse<SkillRow>(findById(database, skillsMapping(), "skill-fill-doc"));
  expect(row.skillName == "fill-doc");
  expect(row.body.indexOf("<CLIENT>") >= 0);
  expect(row.body.indexOf("\"CLIENT\" rather than \"<CLIENT>\"") >= 0);
});

test("seeding twice inserts nothing new and leaves an operator edit in place", () => {
  fresh();
  seedOfficeSkills(database);
  expect(countWhere(database, skillsMapping(), "", []) == 5);
  let mine: SkillRow = {
    id: "skill-make-doc",
    skillName: "make-doc",
    description: "edited by an operator",
    body: "an operator rewrote this",
    updatedAt: "t-operator",
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
  persist(database, skillsMapping(), JSON.stringify(mine));
  expect(countWhere(database, skillsMapping(), "", []) == 5);
  seedOfficeSkills(database);
  expect(countWhere(database, skillsMapping(), "", []) == 5);
  let after: SkillRow = JSON.parse<SkillRow>(findById(database, skillsMapping(), "skill-make-doc"));
  expect(after.description == "edited by an operator");
  expect(after.body == "an operator rewrote this");
  expect(after.visibility == "private");
});

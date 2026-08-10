// The operator's catalog of environment recipes.
//
//   cd packages/agents && lumen test env-templates.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvTemplateRow, EnvTemplateWrite, envTemplateById, envTemplatesAll, envTemplatesPlan, forgetEnvTemplate, saveEnvTemplate } from "./env-templates.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_envtmpl_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS env_templates");
  migrate(database, envTemplatesPlan(database));
}

function put(name: string, image: string, dockerfile: string, rank: int): string {
  let w: EnvTemplateWrite = {
    id: "", name: name, summary: "s", tags: "python, Data ,", image: image, dockerfile: dockerfile, featuredRank: rank, now: "t1",
  };
  saveEnvTemplate(database, w);
  return name;
}

test("a template stores its recipe and normalises its tags", () => {
  fresh();
  put("Python", "python:3.12-slim", "", 0);
  let all = envTemplatesAll(database);
  expect(all.length == 1);
  expect(all[0].source == "image");
  expect(all[0].image == "python:3.12-slim");
  // Tags lowercased, trimmed, empties dropped.
  expect(all[0].tags == "python,data");
});

test("a Dockerfile template is source dockerfile, and image XOR dockerfile is enforced", () => {
  fresh();
  put("DS", "", "FROM python:3.12-slim\nRUN pip install pandas", 0);
  expect(envTemplatesAll(database)[0].source == "dockerfile");
  let both: EnvTemplateWrite = { id: "", name: "x", summary: "", tags: "", image: "a:1", dockerfile: "FROM a", featuredRank: 0, now: "t1" };
  expect(saveEnvTemplate(database, both).indexOf("not both") >= 0);
  let neither: EnvTemplateWrite = { id: "", name: "x", summary: "", tags: "", image: "", dockerfile: "", featuredRank: 0, now: "t1" };
  expect(saveEnvTemplate(database, neither).indexOf("one of the two") >= 0);
  let fromless: EnvTemplateWrite = { id: "", name: "x", summary: "", tags: "", image: "", dockerfile: "RUN echo hi", featuredRank: 0, now: "t1" };
  expect(saveEnvTemplate(database, fromless).indexOf("FROM") >= 0);
});

test("featured templates sort to the front by rank, the rest by name", () => {
  fresh();
  put("Zebra", "z:1", "", 0);
  put("Apple", "a:1", "", 0);
  put("Featured-two", "f2:1", "", 2);
  put("Featured-one", "f1:1", "", 1);
  let all = envTemplatesAll(database);
  expect(all[0].name == "Featured-one");
  expect(all[1].name == "Featured-two");
  // Then the unfeatured, alphabetical.
  expect(all[2].name == "Apple");
  expect(all[3].name == "Zebra");
});

test("save with an id updates in place and keeps the original createdAt", () => {
  fresh();
  put("Python", "python:3.12-slim", "", 0);
  let id = envTemplatesAll(database)[0].id;
  let update: EnvTemplateWrite = { id: id, name: "Python (slim)", summary: "smaller", tags: "python", image: "python:3.12-alpine", dockerfile: "", featuredRank: 0, now: "t2" };
  expect(saveEnvTemplate(database, update) == "");
  let all = envTemplatesAll(database);
  expect(all.length == 1);
  expect(all[0].name == "Python (slim)");
  expect(all[0].image == "python:3.12-alpine");
  expect(all[0].createdAt == "t1");
});

test("a template by id, and deleting one", () => {
  fresh();
  put("Python", "python:3.12-slim", "", 0);
  let id = envTemplatesAll(database)[0].id;
  expect(envTemplateById(database, id).name == "Python");
  expect(envTemplateById(database, "nope").id == "");
  expect(forgetEnvTemplate(database, id));
  expect(!forgetEnvTemplate(database, id));
  expect(envTemplatesAll(database).length == 0);
});

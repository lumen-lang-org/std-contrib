import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, dropTable, findById, listWhere, persist } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { TaskRow, MAX_PER_OWNER, tasksMapping, tasksPlan, stampMs } from "./tasks.ts";
import { callTaskTool, maySchedule, taskTools } from "./task-tools.ts";
import { civil } from "../cron/cron.ts";
import { jsonComplete } from "./scan.ts";

let database: Db = sqlite();

const NOW: number = 1786093200000.0;

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_task_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  dropTable(database, tasksMapping());
  migrate(database, tasksPlan(database));
}

type FileToolResultLike = {
  handled: bool,
  ok: bool,
  text: string,
};

function call(owner: string, name: string, args: string): FileToolResultLike {
  let got = callTaskTool(database, {
    owner: owner, agentId: "a1", modelChoiceId: "",
    name: name, args: args, nowMs: NOW,
  });
  let out: FileToolResultLike = { handled: got.handled, ok: got.ok, text: got.text };
  return out;
}

function quotedRight(text: string): bool {
  let i: int = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      }
      else if (ch == "\\") {
        escaped = true;
      }
      else if (ch == "\"") {
        inString = false;
        let j = i + 1;
        while (j < text.length && (text.charAt(j) == " " || text.charAt(j) == "\n")) {
          j = j + 1;
        }
        if (j < text.length) {
          let next = text.charAt(j);
          if (next != "," && next != ":" && next != "}" && next != "]") {
            return false;
          }
        }
      }
    } else if (ch == "\"") {
      inString = true;
    }
    i = i + 1;
  }
  return !inString;
}

function tasksFor(owner: string): TaskRow[] {
  return JSON.parse<TaskRow[]>(listWhere(database, tasksMapping(),
    "owner = " + database.placeholder, [owner]));
}

function planted(id: string, owner: string, title: string): void {
  plantedWith(id, owner, title, true);
}

function plantedWith(id: string, owner: string, title: string, enabled: bool): void {
  let row: TaskRow = {
    id: id, owner: owner, agentId: "a1", modelChoiceId: "",
    title: title, instruction: "say something",
    kind: "every", cronExpr: "0 0 8 * * 1-5", tz: "Europe/Paris",
    nextAt: `${NOW + 3600000.0}`, runningSince: "",
    enabled: enabled, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, createdAt: "", updatedAt: "",
  };
  persist(database, tasksMapping(), JSON.stringify(row));
}

test("the five names are offered, and nothing else answers to them", () => {
  let specs = taskTools();
  expect(specs.length == 5);
  expect(specs[0].name == "list_tasks");
  expect(specs[1].name == "schedule_task");
  expect(specs[1].schema.indexOf("every weekday at 08:00") >= 0);

  seeded();
  expect(!call("o1", "write_artifact", "{}").handled);
});

test("every schema is a document, because a provider refuses the whole request over one", () => {
  let specs = taskTools();
  let i: int = 0;
  while (i < specs.length) {
    expect(jsonComplete(specs[i].schema));
    expect(quotedRight(specs[i].schema));
    i = i + 1;
  }
  let broken = "{\"properties\":{\"schedule\":{\"description\":\"say \"every day\" here\"}}}";
  expect(jsonComplete(broken));
  expect(!quotedRight(broken));
});

test("a conversation schedules something, and it lands where the person lives", () => {
  seeded();
  let made = call("o1", "schedule_task",
    "{\"instruction\":\"summarise my Linear cycle\",\"schedule\":\"every weekday at 08:00\","
    + "\"title\":\"Morning check\",\"timezone\":\"Europe/Paris\"}");
  expect(made.handled);
  expect(made.ok);

  let rows = tasksFor("o1");
  expect(rows.length == 1);
  expect(rows[0].instruction == "summarise my Linear cycle");
  expect(rows[0].cronExpr == "0 0 8 * * 1-5");
  expect(rows[0].tz == "Europe/Paris");
  expect(rows[0].enabled);
  expect(civil("Europe/Paris", stampMs(rows[0].nextAt) as i64) == "2026-08-10 08:00:00 CEST");
  expect(made.text.indexOf("2026-08-10 08:00") >= 0);
});

test("a date is a task that runs once and is then finished", () => {
  seeded();
  let made = call("o1", "schedule_task",
    "{\"instruction\":\"send the invoice\",\"schedule\":\"on 2026-08-10 at 09:00\",\"timezone\":\"UTC\"}");
  expect(made.ok);
  let rows = tasksFor("o1");
  expect(rows[0].kind == "once");
  expect(rows[0].cronExpr == "");
  expect(civil("UTC", stampMs(rows[0].nextAt) as i64) == "2026-08-10 09:00:00 UTC");

  let past = call("o1", "schedule_task",
    "{\"instruction\":\"x\",\"schedule\":\"on 2020-08-10 at 09:00\",\"timezone\":\"UTC\"}");
  expect(!past.ok);
  expect(past.text.indexOf("in the past") >= 0);
});

test("the zone comes from what they already have, and the answer says so", () => {
  seeded();
  planted("t1", "o1", "Existing");
  let made = call("o1", "schedule_task",
    "{\"instruction\":\"check the queue\",\"schedule\":\"every day at 07:30\"}");
  expect(made.ok);
  let rows = tasksFor("o1");
  let fresh = rows[0].id == "t1" ? rows[1] : rows[0];
  expect(fresh.tz == "Europe/Paris");
  expect(made.text.indexOf("Europe/Paris") >= 0);
});

test("the limits are the route's own, not a second opinion", () => {
  seeded();
  let tooOften = call("o1", "schedule_task",
    "{\"instruction\":\"x\",\"schedule\":\"every 1 minutes\"}");
  expect(!tooOften.ok);
  expect(tooOften.text.indexOf("15 minutes") >= 0);

  let noWhen = call("o1", "schedule_task", "{\"instruction\":\"x\"}");
  expect(!noWhen.ok);
  let noWhat = call("o1", "schedule_task", "{\"schedule\":\"every day at 08:00\"}");
  expect(!noWhat.ok);

  let nowhere = call("o1", "schedule_task",
    "{\"instruction\":\"x\",\"schedule\":\"every day at 08:00\",\"timezone\":\"Mars/Olympus\"}");
  expect(!nowhere.ok);

  let n: int = 0;
  while (n < MAX_PER_OWNER) {
    planted("f" + `${n}`, "o2", "filler " + `${n}`);
    n = n + 1;
  }
  let full = call("o2", "schedule_task",
    "{\"instruction\":\"one more\",\"schedule\":\"every day at 08:00\"}");
  expect(!full.ok);
  expect(full.text.indexOf(`${MAX_PER_OWNER}`) >= 0);
});

test("resuming a paused task through run_task_now is bound by the same cap as creating one", () => {
  seeded();
  let n: int = 0;
  while (n < MAX_PER_OWNER) {
    planted("g" + `${n}`, "o3", "filler " + `${n}`);
    n = n + 1;
  }
  plantedWith("paused", "o3", "Paused one", false);

  let ran = call("o3", "run_task_now", "{\"id\":\"paused\"}");
  expect(!ran.ok);
  expect(ran.text.indexOf(`${MAX_PER_OWNER}`) >= 0);
  let stillPaused = tasksFor("o3");
  let i: int = 0;
  let found = false;
  while (i < stillPaused.length) {
    if (stillPaused[i].id == "paused") {
      expect(!stillPaused[i].enabled);
      found = true;
    }
    i = i + 1;
  }
  expect(found);
});

test("resuming a paused task through change_task is bound by the same cap as creating one", () => {
  seeded();
  let n: int = 0;
  while (n < MAX_PER_OWNER) {
    planted("h" + `${n}`, "o4", "filler " + `${n}`);
    n = n + 1;
  }
  plantedWith("paused2", "o4", "Paused two", false);

  let resumed = call("o4", "change_task", "{\"id\":\"paused2\",\"enabled\":true}");
  expect(!resumed.ok);
  expect(resumed.text.indexOf(`${MAX_PER_OWNER}`) >= 0);
  let stillPaused = tasksFor("o4");
  let i: int = 0;
  let found = false;
  while (i < stillPaused.length) {
    if (stillPaused[i].id == "paused2") {
      expect(!stillPaused[i].enabled);
      found = true;
    }
    i = i + 1;
  }
  expect(found);
});

test("nobody unnamed schedules anything", () => {
  seeded();
  expect(!maySchedule("guest:abc"));
  let asGuest = call("guest:abc", "schedule_task",
    "{\"instruction\":\"x\",\"schedule\":\"every day at 08:00\"}");
  expect(asGuest.handled);
  expect(!asGuest.ok);
  expect(tasksFor("guest:abc").length == 0);
  expect(!call("guest:abc", "list_tasks", "{}").ok);
});

test("one person's tasks are absent to another, not forbidden", () => {
  seeded();
  planted("t1", "o1", "Theirs");

  let mine = call("o2", "list_tasks", "{}");
  expect(mine.ok);
  expect(mine.text.indexOf("Theirs") < 0);

  let stolen = call("o2", "change_task", "{\"id\":\"t1\",\"enabled\":false}");
  expect(!stolen.ok);
  expect(stolen.text.indexOf("no task") >= 0);
  expect(!call("o2", "delete_task", "{\"id\":\"t1\"}").ok);
  expect(!call("o2", "run_task_now", "{\"id\":\"t1\"}").ok);

  let still: TaskRow = JSON.parse<TaskRow>(findById(database, tasksMapping(), "t1"));
  expect(still.enabled);
});

test("a task is changed by id or by the name a person would use", () => {
  seeded();
  planted("t1", "o1", "Morning check");

  let paused = call("o1", "change_task", "{\"id\":\"Morning check\",\"enabled\":false}");
  expect(paused.ok);
  let after: TaskRow = JSON.parse<TaskRow>(findById(database, tasksMapping(), "t1"));
  expect(!after.enabled);

  let moved = call("o1", "change_task", "{\"id\":\"t1\",\"schedule\":\"every 30 minutes\",\"enabled\":true}");
  expect(moved.ok);
  let now: TaskRow = JSON.parse<TaskRow>(findById(database, tasksMapping(), "t1"));
  expect(now.cronExpr == "0 */30 * * * *");
  expect(now.instruction == "say something");
  expect(now.enabled);

  let refused = call("o1", "change_task", "{\"id\":\"t1\",\"schedule\":\"every fortnight\"}");
  expect(!refused.ok);
  let unchanged: TaskRow = JSON.parse<TaskRow>(findById(database, tasksMapping(), "t1"));
  expect(unchanged.cronExpr == "0 */30 * * * *");
});

test("two tasks by one name is a question, not a guess", () => {
  seeded();
  planted("t1", "o1", "Check");
  planted("t2", "o1", "Check");
  expect(!call("o1", "delete_task", "{\"id\":\"Check\"}").ok);
  expect(tasksFor("o1").length == 2);
});

test("run now moves the next firing and fires nothing itself", () => {
  seeded();
  planted("t1", "o1", "Morning check");
  let asked = call("o1", "run_task_now", "{\"id\":\"t1\"}");
  expect(asked.ok);
  let row: TaskRow = JSON.parse<TaskRow>(findById(database, tasksMapping(), "t1"));
  expect(stampMs(row.nextAt) <= NOW);
  expect(asked.text.indexOf("conversation of its own") >= 0);
});

test("delete is for gone, and it is the only one that is", () => {
  seeded();
  planted("t1", "o1", "Morning check");
  expect(call("o1", "delete_task", "{\"id\":\"t1\"}").ok);
  expect(tasksFor("o1").length == 0);
  expect(!call("o1", "delete_task", "{\"id\":\"t1\"}").ok);
});

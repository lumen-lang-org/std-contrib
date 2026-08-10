import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, createTableSql } from "../plume/plume.ts";
import { Migration, migrate, migration, forgetMigrations } from "../plume/migrate.ts";
import { officeRendersMapping } from "./schema.ts";
import { envDockerOverride } from "./environments.ts";
import { OfficeRenderAsk, OfficeRendered, officeRender, officeRenderCached, officeRenderExt, officeRenderImageOverride } from "./office-render.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_render_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS office_renders");
  let plan: Migration[] = [
    migration("81", "office documents converted to pdf",
      createTableSql(database, officeRendersMapping())),
  ];
  migrate(database, plan);
  officeRenderImageOverride("agents-office-render:test");
}

const FAKE_DIR = "/tmp/agents_render_fake";
const FAKE_LOG = "/tmp/agents_render_fake/argv.log";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) {
    fs.mkdirSync(FAKE_DIR);
  }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  envDockerOverride(bin);
}

function dockerConverts(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"cp\" ]; then case \"$2\" in *:*) printf '%%PDF-1.4' > \"$3\";; esac; fi\n"
    + "exit 0\n");
}

function dockerAbsent(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "echo 'Cannot connect to the Docker daemon' >&2\n"
    + "exit 1\n");
}

function dockerTimesOut(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; exit 0; fi\n"
    + "if [ \"$1\" = \"exec\" ]; then exit 124; fi\n"
    + "exit 0\n");
}

function dockerWritesNothing(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; exit 0; fi\n"
    + "if [ \"$1\" = \"cp\" ]; then case \"$2\" in *:*) exit 1;; esac; fi\n"
    + "exit 0\n");
}

function argvLines(): string[] {
  if (!fs.existsSync(FAKE_LOG)) {
    let none: string[] = [];
    return none;
  }
  let text = fs.readFileSync(FAKE_LOG);
  let out: string[] = [];
  let parts = text.split("\n");
  let i: int = 0;
  while (i < parts.length) {
    if (parts[i].trim() != "") {
      out.push(parts[i].trim());
    }
    i = i + 1;
  }
  return out;
}

const SOME_BODY: string = "aGVsbG8=";

function render(path: string, version: int, body: string): OfficeRendered {
  let ask: OfficeRenderAsk = {
    artifactId: "a1", version: version, path: path, body: body, now: "1700000000000",
  };
  return officeRender(database, ask);
}

test("the door is a fixed list of three formats, not whatever LibreOffice can open", () => {
  expect(officeRenderExt("/artifacts/docs/a.docx") == "docx");
  expect(officeRenderExt("/artifacts/sheets/a.xlsx") == "xlsx");
  expect(officeRenderExt("/artifacts/decks/a.pptx") == "pptx");
  expect(officeRenderExt("/A.DOCX") == "docx");
  expect(officeRenderExt("/a.odt") == "");
  expect(officeRenderExt("/a.doc") == "");
  expect(officeRenderExt("/a.pdf") == "");
  expect(officeRenderExt("/a.html") == "");
  expect(officeRenderExt("/a") == "");
});

test("a format that is not converted is refused before any container exists", () => {
  fresh();
  dockerConverts();
  let out = render("/notes.md", 1, SOME_BODY);

  expect(!out.ok);
  expect(out.fault.indexOf(".docx") > 0);
  expect(argvLines().length == 0);
});

test("the converter runs with no network, no capabilities and bounded resources", () => {
  fresh();
  dockerConverts();
  render("/a.docx", 1, SOME_BODY);
  let made = argvLines()[0];

  expect(made.indexOf("run -d --name agents-render-") == 0);
  expect(made.indexOf("--network none") > 0);
  expect(made.indexOf("--memory 1g") > 0);
  expect(made.indexOf("--cpus 2") > 0);
  expect(made.indexOf("--pids-limit 256") > 0);
  expect(made.indexOf("--security-opt no-new-privileges") > 0);
  expect(made.indexOf("--cap-drop ALL") > 0);
  expect(made.indexOf("--cap-add") < 0);
  expect(made.indexOf("--privileged") < 0);
  expect(made.indexOf("agents-office-render:test infinity") > 0);
});

test("the document is handed over unprivileged, and the container is destroyed after", () => {
  fresh();
  dockerConverts();
  render("/a.docx", 1, SOME_BODY);
  let asked = argvLines();

  expect(asked.length == 5);
  expect(asked[1].indexOf("cp ") == 0);
  expect(asked[1].indexOf(":/work/in.docx") > 0);
  expect(asked[2].indexOf("exec --user 65534:65534") == 0);
  expect(asked[2].indexOf("soffice --headless") > 0);
  expect(asked[3].indexOf(":/work/in.pdf") > 0);
  expect(asked[4].indexOf("rm -f agents-render-") == 0);
});

test("the container is destroyed even when the conversion fails", () => {
  fresh();
  dockerTimesOut();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  let asked = argvLines();
  expect(asked[asked.length - 1].indexOf("rm -f agents-render-") == 0);
});

test("nothing derived from the artifact reaches the container", () => {
  fresh();
  dockerConverts();
  render("/artifacts/docs/'; rm -rf /; echo '.docx", 1, SOME_BODY);
  let asked = argvLines();

  let exec = asked[2];
  expect(exec.indexOf("rm -rf") < 0);
  expect(exec.indexOf("/work/in.docx") > 0);
});

test("a converted version is stored, and the second read converts nothing", () => {
  fresh();
  dockerConverts();
  let first = render("/a.docx", 1, SOME_BODY);
  expect(first.ok);
  expect(!first.cached);
  expect(first.body != "");
  let ranFirst = argvLines().length;
  expect(ranFirst == 5);

  let second = render("/a.docx", 1, SOME_BODY);
  expect(second.ok);
  expect(second.cached);
  expect(second.body == first.body);
  expect(argvLines().length == ranFirst);
});

test("a new version is its own conversion, and does not disturb the old one", () => {
  fresh();
  dockerConverts();
  let one = render("/a.docx", 1, SOME_BODY);
  let two = render("/a.docx", 2, SOME_BODY);

  expect(one.ok);
  expect(two.ok);
  expect(!two.cached);
  expect(officeRenderCached(database, "a1", 1) != "");
  expect(officeRenderCached(database, "a1", 2) != "");
});

test("a failed conversion stores nothing, so a retry is a real retry", () => {
  fresh();
  dockerWritesNothing();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  expect(officeRenderCached(database, "a1", 1) == "");
});

test("a converter that will not start names the image, which is the actionable half", () => {
  fresh();
  dockerAbsent();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  expect(out.fault.indexOf("agents-office-render:test") > 0);
  expect(out.body == "");
});

test("a conversion that runs out of time says so, rather than blaming the document", () => {
  fresh();
  dockerTimesOut();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  expect(out.fault.indexOf("seconds") > 0);
});

test("a converter that exits 0 having written nothing is a failure, not an empty PDF", () => {
  fresh();
  dockerWritesNothing();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  expect(out.fault.indexOf("no PDF") > 0);
});

test("a body that is not base64 is refused without starting a conversion", () => {
  fresh();
  dockerConverts();
  let out = render("/a.docx", 1, "not base64 at all !!!");

  expect(!out.ok);
  expect(out.fault.indexOf("base64") > 0);
  let asked = argvLines();
  expect(asked.length == 0 || asked[asked.length - 1].indexOf("rm -f") == 0);
});

test("a conversion names an artifact, a version and a body", () => {
  fresh();
  dockerConverts();

  let noVersion: OfficeRenderAsk = {
    artifactId: "a1", version: 0, path: "/a.docx", body: SOME_BODY, now: "1700000000000",
  };
  expect(!officeRender(database, noVersion).ok);

  let noBody: OfficeRenderAsk = {
    artifactId: "a1", version: 1, path: "/a.docx", body: "", now: "1700000000000",
  };
  let empty = officeRender(database, noBody);
  expect(!empty.ok);
  expect(empty.fault.indexOf("no body") > 0);

  expect(argvLines().length == 0);
});

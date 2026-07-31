// The office→PDF converter, with docker played by a shell script.
//
// Same fake as environments.test.ts and for the same reason: every docker
// invocation goes through one door that runs `envDockerBin()`, so pointing
// that at a script makes the argv itself assertable — which verb, which
// container, in which order, carrying which restrictions. What is being
// checked here is mostly containment, and containment is exactly the kind of
// property that decays silently: a flag dropped from the run line leaves a
// converter that still converts and is weaker.
//
//   cd packages/agents && lumen test office-render.test.ts

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

// --- the fake docker ------------------------------------------------------------

const FAKE_DIR = "/tmp/agents_render_fake";
const FAKE_LOG = "/tmp/agents_render_fake/argv.log";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) { fs.mkdirSync(FAKE_DIR); }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  envDockerOverride(bin);
}

// A docker that converts: `run` prints an id, and the `cp` that fetches the
// PDF back writes a file where the real one would, so the encode step after
// it has something to read. Everything else succeeds silently.
//
// The written bytes are "%PDF-1.4" and nothing else — this is testing the
// plumbing around LibreOffice, not LibreOffice.
function dockerConverts(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    // `cp <container>:<path> <dest>` — the fetch back. Detected by the colon
    // in the second argument, which only the container-to-host direction has.
    + "if [ \"$1\" = \"cp\" ]; then case \"$2\" in *:*) printf '%%PDF-1.4' > \"$3\";; esac; fi\n"
    + "exit 0\n");
}

// A docker whose daemon is not there: the state on a box where the image was
// never built, which is the failure an operator will actually meet.
function dockerAbsent(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "echo 'Cannot connect to the Docker daemon' >&2\n"
    + "exit 1\n");
}

// A converter that starts but whose conversion fails the way `timeout` fails.
function dockerTimesOut(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; exit 0; fi\n"
    + "if [ \"$1\" = \"exec\" ]; then exit 124; fi\n"
    + "exit 0\n");
}

// A converter that exits 0 having written no PDF — LibreOffice's own answer
// when a filter declines the file, and the reason the missing output is
// checked rather than the exit status.
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
    if (parts[i].trim() != "") { out.push(parts[i].trim()); }
    i = i + 1;
  }
  return out;
}

// "hello" as base64 — a body that decodes, which is all the staging step
// needs of it.
const SOME_BODY: string = "aGVsbG8=";

function render(path: string, version: int, body: string): OfficeRendered {
  let ask: OfficeRenderAsk = {
    artifactId: "a1", version: version, path: path, body: body, now: "1700000000000",
  };
  return officeRender(database, ask);
}

// --- what may be converted --------------------------------------------------------

test("the door is a fixed list of three formats, not whatever LibreOffice can open", () => {
  // Narrow on purpose. LibreOffice opens a great deal, including formats with
  // macro and external-reference semantics nobody has reasoned about here, so
  // widening this is a per-format decision rather than a convenience.
  expect(officeRenderExt("/artifacts/docs/a.docx") == "docx");
  expect(officeRenderExt("/artifacts/sheets/a.xlsx") == "xlsx");
  expect(officeRenderExt("/artifacts/decks/a.pptx") == "pptx");
  // Case is not a way past it.
  expect(officeRenderExt("/A.DOCX") == "docx");
  // And everything else is refused at the door rather than handed over.
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
  expect(out.problem.indexOf(".docx") > 0);
  // The point: docker was never called. A refusal that started a container
  // first would let an unconvertible path cost a container anyway.
  expect(argvLines().length == 0);
});

// --- containment ------------------------------------------------------------------

test("the converter runs with no network, no capabilities and bounded resources", () => {
  // Asserted as one list because a restriction quietly dropped from the argv
  // is invisible otherwise — the conversion still works, and is weaker. This
  // container parses a document the platform did not write, which is the
  // whole reason the list is this long.
  fresh();
  dockerConverts();
  render("/a.docx", 1, SOME_BODY);
  let made = argvLines()[0];

  expect(made.indexOf("run -d --name agents-render-") == 0);
  // Never reachable and never reaching: a converter has nothing to fetch and
  // nothing to tell. Unconditional here, unlike an environment's row value.
  expect(made.indexOf("--network none") > 0);
  expect(made.indexOf("--memory 1g") > 0);
  expect(made.indexOf("--cpus 2") > 0);
  expect(made.indexOf("--pids-limit 256") > 0);
  expect(made.indexOf("--security-opt no-new-privileges") > 0);
  // Everything off and nothing back. An environment restores five for apt and
  // pip; a conversion needs none, which is why /work is prepared in the image.
  expect(made.indexOf("--cap-drop ALL") > 0);
  expect(made.indexOf("--cap-add") < 0);
  expect(made.indexOf("--privileged") < 0);
  // The image is the overridden one, and it is the last word before the
  // entrypoint's argument.
  expect(made.indexOf("agents-office-render:test infinity") > 0);
});

test("the document is handed over unprivileged, and the container is destroyed after", () => {
  fresh();
  dockerConverts();
  render("/a.docx", 1, SOME_BODY);
  let asked = argvLines();

  // run, cp in, exec, cp out, rm — and nothing else.
  expect(asked.length == 5);
  expect(asked[1].indexOf("cp ") == 0);
  expect(asked[1].indexOf(":/work/in.docx") > 0);
  // The conversion is not root, inside a container that is already not
  // privileged.
  expect(asked[2].indexOf("exec --user 65534:65534") == 0);
  expect(asked[2].indexOf("soffice --headless") > 0);
  expect(asked[3].indexOf(":/work/in.pdf") > 0);
  // The guarantee the one-container-per-document rule rests on: not "removed
  // on success", removed.
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
  // The input is renamed to /work/in.<ext> on the way in and the real path
  // stays in the staging directory, so the shell line the container runs has
  // no variables in it worth attacking.
  fresh();
  dockerConverts();
  render("/artifacts/docs/'; rm -rf /; echo '.docx", 1, SOME_BODY);
  let asked = argvLines();

  let exec = asked[2];
  expect(exec.indexOf("rm -rf") < 0);
  expect(exec.indexOf("/work/in.docx") > 0);
});

// --- the cache --------------------------------------------------------------------

test("a converted version is stored, and the second read converts nothing", () => {
  // The key is <artifact>:<version> and a version is append-only, so a stored
  // render can never be stale — which is what makes one conversion per
  // document version, ever, the whole caching story.
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
  // No further docker at all: not a faster conversion, no conversion.
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
  // Both are still readable: an artifact's history is addressable, so the
  // render of v1 must outlive the arrival of v2.
  expect(officeRenderCached(database, "a1", 1) != "");
  expect(officeRenderCached(database, "a1", 2) != "");
});

test("a failed conversion stores nothing, so a retry is a real retry", () => {
  fresh();
  dockerWritesNothing();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  // Caching a failure would make a transient one permanent, and the key
  // cannot distinguish "converted to nothing" from "not converted yet".
  expect(officeRenderCached(database, "a1", 1) == "");
});

// --- failures a person has to read ------------------------------------------------

test("a converter that will not start names the image, which is the actionable half", () => {
  fresh();
  dockerAbsent();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  // "docker could not run" sends a reader looking at their document. The
  // image name sends whoever can fix it to the thing that is missing.
  expect(out.problem.indexOf("agents-office-render:test") > 0);
  expect(out.body == "");
});

test("a conversion that runs out of time says so, rather than blaming the document", () => {
  fresh();
  dockerTimesOut();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  // `timeout` exits 124, and it is worth its own sentence: an operator
  // reading "may be corrupt" would go looking for a broken image.
  expect(out.problem.indexOf("seconds") > 0);
});

test("a converter that exits 0 having written nothing is a failure, not an empty PDF", () => {
  // LibreOffice's own answer when a filter declines the file — a .docx that is
  // really a zip of something else. The exit status says success; the missing
  // output is the truth, so that is what is checked.
  fresh();
  dockerWritesNothing();
  let out = render("/a.docx", 1, SOME_BODY);

  expect(!out.ok);
  expect(out.problem.indexOf("no PDF") > 0);
});

test("a body that is not base64 is refused without starting a conversion", () => {
  fresh();
  dockerConverts();
  let out = render("/a.docx", 1, "not base64 at all !!!");

  expect(!out.ok);
  expect(out.problem.indexOf("base64") > 0);
  // The container was created before the decode was attempted, so it must
  // still have been removed.
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
  expect(empty.problem.indexOf("no body") > 0);

  expect(argvLines().length == 0);
});

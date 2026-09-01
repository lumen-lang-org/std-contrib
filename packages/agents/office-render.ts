import { Db } from "../plume/driver.ts";
import { findById, persist } from "../plume/plume.ts";
import { EnvDockerReply, envDockerBin } from "./environments.ts";
import { OfficeRenderRow, officeRendersMapping } from "./schema.ts";
import { getVersion, listArtifacts } from "./artifacts.ts";

export const OFFICE_RENDER_IMAGE: string = "agents-all:1";

const OFFICE_RENDER_SECONDS: int = 120;

const OFFICE_RESIDENT_NAME: string = "agents-office-resident";

const OFFICE_UNO_PORT: string = "2002";

const OFFICE_RENDER_MAX: int = 12000000;

/* Extracted text is capped well below the PDF it came from. A person reads a
 * document; a model is handed one, and 400k characters is around a hundred
 * pages — past that the answer is a search, not a read. What is dropped is
 * said in the text itself rather than trimmed in silence. */
const OFFICE_TEXT_MAX: int = 400000;

let officeRenderChosenImage: string = "";

export function officeRenderImageOverride(image: string): void {
  officeRenderChosenImage = image;
}

export function officeRenderImage(): string {
  if (officeRenderChosenImage != "") {
    return officeRenderChosenImage;
  }
  return process.env("AGENTS_OFFICE_RENDER_IMAGE") ?? OFFICE_RENDER_IMAGE;
}

/* The formats a document's words can be got out of, which is a different list
 * from the ones that can be drawn: a .pdf is never rendered here and is the
 * commonest thing anybody attaches. */
export function officeTextExt(path: string): string {
  let lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  return officeRenderExt(path);
}

export function officeRenderExt(path: string): string {
  let lower = path.toLowerCase();
  if (lower.endsWith(".docx")) {
    return "docx";
  }
  if (lower.endsWith(".xlsx")) {
    return "xlsx";
  }
  if (lower.endsWith(".pptx")) {
    return "pptx";
  }
  return "";
}

export type OfficeRendered = {
  ok: bool,
  body: string,
  cached: bool,
  fault: string,
};

function officeRenderRefused(why: string): OfficeRendered {
  let out: OfficeRendered = { ok: false, body: "", cached: false, fault: why };
  return out;
}

function officeRenderDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function officeResidentListenerCmd(): string {
  return "mkdir -p /tmp/lo && cd /tmp && exec soffice --headless --invisible"
    + " --nodefault --nologo --norestore -env:UserInstallation=file:///tmp/lo"
    + " --accept=\"socket,host=127.0.0.1,port=" + OFFICE_UNO_PORT + ";urp;\"";
}

function officeResidentRunArgs(): string[] {
  let out: string[] = ["run", "-d", "--name", OFFICE_RESIDENT_NAME];
  out.push("--network"); out.push("none");
  out.push("--memory"); out.push("1g");
  out.push("--cpus"); out.push("2");
  out.push("--pids-limit"); out.push("256");
  out.push("--security-opt"); out.push("no-new-privileges");
  out.push("--cap-drop"); out.push("ALL");
  out.push("--user"); out.push("65534:65534");
  out.push("--entrypoint"); out.push("sh");
  out.push(officeRenderImage());
  out.push("-c"); out.push(officeResidentListenerCmd());
  return out;
}

let officeResidentUp: bool = false;

export function officeResidentForget(): void {
  officeResidentUp = false;
}

function officeResidentReady(): bool {
  let seen = officeRenderDocker(["inspect", "-f", "{{.State.Running}}", OFFICE_RESIDENT_NAME]);
  let up = seen.status == 0 && seen.stdout.trim() == "true";
  officeResidentUp = up;
  return up;
}

function officeResidentWait(): void {
  officeRenderDocker(["exec", OFFICE_RESIDENT_NAME, "python3", "-c",
    "import socket,time\nfor _ in range(60):\n try:\n  socket.create_connection((\"127.0.0.1\","
    + OFFICE_UNO_PORT + "),0.5).close(); break\n except Exception:\n  time.sleep(0.5)"]);
}

function officeResidentEnsure(): string {
  if (officeResidentUp) {
    return "";
  }
  if (officeResidentReady()) {
    return "";
  }
  officeRenderDocker(["rm", "-f", OFFICE_RESIDENT_NAME]);
  let made = officeRenderDocker(officeResidentRunArgs());
  if (made.status != 0) {
    return "the document converter could not start (" + officeRenderImage() + " — is it built?)";
  }
  officeResidentWait();
  return "";
}

function officeUnoconvCmd(inName: string, outName: string): string {
  return "HOME=/tmp timeout " + `${OFFICE_RENDER_SECONDS}`
    + " unoconv -f pdf -p " + OFFICE_UNO_PORT + " -o " + outName + " " + inName
    + " >/dev/null 2>&1";
}

let officeRenderSeq: int = 0;

function officeRenderStage(now: string): string {
  officeRenderSeq = officeRenderSeq + 1;
  return "/tmp/agents-render-" + officeRenderDigits(now) + "-" + `${officeRenderSeq}`;
}

function officeRenderDigits(now: string): string {
  let out = "";
  let i: int = 0;
  while (i < now.length) {
    let c = now.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      out = out + now.charAt(i);
    }
    i = i + 1;
  }
  return out == "" ? "0" : out;
}

function officeRenderHostDir(dir: string): string {
  try {
    fs.mkdirSync(dir, true);
  } catch (e) {
    return "the conversion's staging directory could not be created";
  }
  return "";
}

function officeRenderDrop(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, true);
    }
  } catch (e) {
    return;
  }
}

function officeRenderDecode(stage: string, ext: string, body: string): string {
  try {
    fs.writeFileSync(stage + "/in.b64", body);
  } catch (e) {
    return "the document could not be staged for conversion";
  }
  let dec = child_process.spawnSync("sh", ["-c",
    "base64 -d < '" + stage + "/in.b64' > '" + stage + "/in." + ext + "'"]);
  if (dec.status != 0) {
    return "this document's stored body is not base64, so there is nothing to convert";
  }
  return "";
}

function officeRenderEncode(path: string): string {
  let enc = child_process.spawnSync("base64", ["-w0", path]);
  if (enc.status != 0) {
    return "";
  }
  return enc.stdout.trim();
}

/* What a conversion is filed under: the bytes, not the artifact.
 *
 * It used to be artifactId:version, which is unique per conversation — so
 * every person who opened the same template waited twenty seconds for
 * LibreOffice to draw a document that had already been drawn a hundred times.
 * The same bytes convert to the same page whoever holds them, so the digest
 * of the body is the honest key, and the second opener waits for a database
 * read. The old rows stay where they are and simply stop being found. */
function officeRenderKey(artifactId: string, version: int): string {
  return artifactId + ":" + `${version}`;
}

function officeBytesKey(body: string): string {
  return "sha:" + crypto.sha256(body);
}

export function officeRenderCached(db: Db, artifactId: string, version: int): string {
  let held = findById(db, officeRendersMapping(), officeRenderKey(artifactId, version));
  if (held == "") {
    return "";
  }
  let row = JSON.parse<OfficeRenderRow>(held);
  return row.body;
}

/** The same conversion, found by what was converted rather than by whose copy
 *  it was. A template opened by a hundred people is drawn once. */
function officeCachedBytes(db: Db, body: string): string {
  let held = findById(db, officeRendersMapping(), officeBytesKey(body));
  if (held == "") {
    return "";
  }
  let row = JSON.parse<OfficeRenderRow>(held);
  return row.body;
}

function officeStoreBytes(db: Db, key: string, body: string, now: string): void {
  let row: OfficeRenderRow = {
    id: key, artifactId: "", version: 0, body: body, createdAt: now,
  };
  persist(db, officeRendersMapping(), JSON.stringify(row));
}

function officeRenderStore(db: Db, artifactId: string, version: int, body: string, now: string): void {
  let row: OfficeRenderRow = {
    id: officeRenderKey(artifactId, version),
    artifactId: artifactId,
    version: version,
    body: body,
    createdAt: now,
  };
  persist(db, officeRendersMapping(), JSON.stringify(row));
}

export type OfficeRenderAsk = {
  artifactId: string,
  version: int,
  path: string,
  body: string,
  now: string,
};

export function officeWarmThread(db: Db, threadId: string, now: string): int {
  let arts = listArtifacts(db, threadId);
  let warmed: int = 0;
  let i: int = 0;
  while (i < arts.length) {
    let a = arts[i];
    i = i + 1;
    if (officeRenderExt(a.path) == "" || a.currentVersion < 1) {
      continue;
    }
    if (officeRenderCached(db, a.id, a.currentVersion) != "") {
      continue;
    }
    let v = getVersion(db, a.id, a.currentVersion);
    if (v.body == "") {
      continue;
    }
    let ask: OfficeRenderAsk = {
      artifactId: a.id, version: a.currentVersion, path: a.path, body: v.body, now: now,
    };
    let out = officeRender(db, ask);
    if (out.ok) {
      warmed = warmed + 1;
    }
  }
  return warmed;
}

export function officeRender(db: Db, ask: OfficeRenderAsk): OfficeRendered {
  let ext = officeRenderExt(ask.path);
  if (ext == "") {
    return officeRenderRefused("only .docx, .xlsx and .pptx can be converted to PDF");
  }
  if (ask.artifactId == "" || ask.version < 1) {
    return officeRenderRefused("a conversion names an artifact and a version");
  }
  if (ask.body == "") {
    return officeRenderRefused("this version has no body to convert");
  }

  let held = officeRenderCached(db, ask.artifactId, ask.version);
  if (held == "") {
    held = officeCachedBytes(db, ask.body);
  }
  if (held != "") {
    let hit: OfficeRendered = { ok: true, body: held, cached: true, fault: "" };
    return hit;
  }

  let stage = officeRenderStage(ask.now);
  let staged = officeRenderHostDir(stage);
  if (staged != "") {
    return officeRenderRefused(staged);
  }
  let decoded = officeRenderDecode(stage, ext, ask.body);
  if (decoded != "") {
    officeRenderDrop(stage);
    return officeRenderRefused(decoded);
  }

  let tag = officeRenderDigits(ask.now) + "-" + `${officeRenderSeq}`;
  let ready = officeResidentEnsure();
  if (ready != "") {
    officeRenderDrop(stage);
    return officeRenderRefused(ready);
  }
  let out = officeRenderConvert(db, tag, stage, ext, ask);
  if (!out.ok && !officeResidentReady()) {
    let again = officeResidentEnsure();
    if (again == "") {
      out = officeRenderConvert(db, tag, stage, ext, ask);
    }
  }
  officeRenderDrop(stage);
  return out;
}

function officeRenderConvert(db: Db, tag: string, stage: string, ext: string, ask: OfficeRenderAsk): OfficeRendered {
  let inName = "/tmp/in-" + tag + "." + ext;
  let outName = "/tmp/out-" + tag + ".pdf";
  let placed = officeRenderDocker(["cp", stage + "/in." + ext, OFFICE_RESIDENT_NAME + ":" + inName]);
  if (placed.status != 0) {
    return officeRenderRefused("the document could not be handed to the converter");
  }
  let ran = officeRenderDocker(["exec", OFFICE_RESIDENT_NAME, "sh", "-c",
    officeUnoconvCmd(inName, outName)]);
  if (ran.status != 0) {
    officeRenderDocker(["exec", OFFICE_RESIDENT_NAME, "rm", "-f", inName]);
    if (ran.status == 124) {
      return officeRenderRefused("this document took longer than "
        + `${OFFICE_RENDER_SECONDS}` + " seconds to convert, so it was stopped");
    }
    return officeRenderRefused("this document could not be converted — it may be corrupt");
  }
  let back = officeRenderDocker(["cp", OFFICE_RESIDENT_NAME + ":" + outName, stage + "/out.pdf"]);
  officeRenderDocker(["exec", OFFICE_RESIDENT_NAME, "rm", "-f", inName, outName]);
  if (back.status != 0) {
    return officeRenderRefused("the converter produced no PDF for this document");
  }
  let b64 = officeRenderEncode(stage + "/out.pdf");
  if (b64 == "") {
    return officeRenderRefused("the converted PDF could not be read back");
  }
  if (b64.length > OFFICE_RENDER_MAX) {
    return officeRenderRefused("this document converts to more than "
      + `${OFFICE_RENDER_MAX / 1000000}` + "MB of PDF, which is too large to preview — download it instead");
  }
  officeRenderStore(db, ask.artifactId, ask.version, b64, ask.now);
  officeStoreBytes(db, officeBytesKey(ask.body), b64, ask.now);
  let done: OfficeRendered = { ok: true, body: b64, cached: false, fault: "" };
  return done;
}


/* Reading a document, as opposed to drawing one.
 *
 * The same container, the same one-conversion-per-container rule, a different
 * question: what does it say. Until this existed a model handed a .pdf got
 * base64 out of read_artifact and wrote a parser for it in a script sandbox,
 * every time, from scratch — a regex over the content streams. That works on
 * a document generated an hour ago and returns confident nonsense on one with
 * subset fonts or a scanner behind it, which is the worst of both.
 *
 * A .xlsx is read as CSV rather than through the PDF, for the reason the
 * console never draws one either: paginating a grid loses the columns that
 * run off the page, and a sheet's value is the cells. Everything else goes
 * through the PDF we already make for the reader, so a document somebody has
 * looked at costs only the pdftotext.
 *
 * The filter's last token is what asks for every sheet rather than the first
 * one, which is why they are concatenated back together afterwards. */
const XLSX_CSV_FILTER: string =
  "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1";

export type OfficeTexted = {
  ok: bool,
  text: string,
  cached: bool,
  fault: string,
};

type OfficeTextRun = {
  ok: bool,
  text: string,
  fault: string,
};

function officeTextRefused(why: string): OfficeTexted {
  let out: OfficeTexted = { ok: false, text: "", cached: false, fault: why };
  return out;
}

function officeTextFailed(why: string): OfficeTextRun {
  let out: OfficeTextRun = { ok: false, text: "", fault: why };
  return out;
}

function officeTextKey(artifactId: string, version: int): string {
  return officeRenderKey(artifactId, version) + ":text";
}

export function officeTextCached(db: Db, artifactId: string, version: int): string {
  let held = findById(db, officeRendersMapping(), officeTextKey(artifactId, version));
  if (held == "") {
    return "";
  }
  let row = JSON.parse<OfficeRenderRow>(held);
  return row.body;
}

function officeTextStore(db: Db, artifactId: string, version: int, text: string, now: string): void {
  let row: OfficeRenderRow = {
    id: officeTextKey(artifactId, version),
    artifactId: artifactId,
    version: version,
    body: text,
    createdAt: now,
  };
  persist(db, officeRendersMapping(), JSON.stringify(row));
}

function officeTextCommand(ext: string): string {
  if (ext == "docx") {
    // Straight to text, one container. It used to go through the PDF we draw
    // for the reader and then pdftotext, which is two containers and two cold
    // LibreOffice starts: 46 seconds in front of somebody filling a template.
    return "cd /work && HOME=/work XDG_CACHE_HOME=/work"
      + " timeout " + `${OFFICE_RENDER_SECONDS}`
      + " soffice --headless --norestore --nolockcheck"
      + " -env:UserInstallation=file:///work/lo"
      + " --convert-to 'txt:Text (encoded):UTF8' --outdir /work /work/in.docx"
      + " >/dev/null 2>&1 && mv /work/in.txt /work/out.txt";
  }
  if (ext == "xlsx") {
    return "cd /work && HOME=/work XDG_CACHE_HOME=/work"
      + " timeout " + `${OFFICE_RENDER_SECONDS}`
      + " soffice --headless --norestore --nolockcheck"
      + " -env:UserInstallation=file:///work/lo"
      + " --convert-to '" + XLSX_CSV_FILTER + "' --outdir /work /work/in.xlsx"
      + " >/dev/null 2>&1 && cat /work/in*.csv > /work/out.txt";
  }
  return "cd /work && timeout " + `${OFFICE_RENDER_SECONDS}`
    + " pdftotext -q -enc UTF-8 -eol unix /work/in.pdf /work/out.txt";
}

function officeTextCapped(text: string): string {
  if (text.length <= OFFICE_TEXT_MAX) {
    return text;
  }
  return text.slice(0, OFFICE_TEXT_MAX)
    + "\n\n[This document is longer than " + `${OFFICE_TEXT_MAX}`
    + " characters. Everything after that point is not here, so do not answer"
    + " \"the document does not say\" from this text alone.]";
}

function officeTextInside(container: string, stage: string, inExt: string, command: string): OfficeTextRun {
  let placed = officeRenderDocker(["cp", stage + "/in." + inExt, container + ":/work/in." + inExt]);
  if (placed.status != 0) {
    return officeTextFailed("the document could not be handed to the reader");
  }
  let ran = officeRenderDocker(["exec", "--user", "65534:65534", container,
    "sh", "-c", command]);
  if (ran.status != 0) {
    if (ran.status == 124) {
      return officeTextFailed("this document took longer than "
        + `${OFFICE_RENDER_SECONDS}` + " seconds to read, so it was stopped");
    }
    return officeTextFailed("this document could not be read — it may be corrupt");
  }
  let back = officeRenderDocker(["cp", container + ":/work/out.txt", stage + "/out.txt"]);
  if (back.status != 0) {
    return officeTextFailed("the reader found no text in this document");
  }
  let text = "";
  try {
    text = fs.readFileSync(stage + "/out.txt");
  } catch (e) {
    return officeTextFailed("the text this document holds could not be read back");
  }
  let done: OfficeTextRun = { ok: true, text: text, fault: "" };
  return done;
}

function officeTextRunArgs(container: string): string[] {
  let out: string[] = ["run", "-d", "--name", container];
  out.push("--network"); out.push("none");
  out.push("--memory"); out.push("1g");
  out.push("--cpus"); out.push("2");
  out.push("--pids-limit"); out.push("256");
  out.push("--security-opt"); out.push("no-new-privileges");
  out.push("--cap-drop"); out.push("ALL");
  out.push("--entrypoint"); out.push("sleep");
  out.push(officeRenderImage()); out.push("infinity");
  return out;
}

function officeTextRun(inExt: string, body: string, command: string, now: string): OfficeTextRun {
  let stage = officeRenderStage(now);
  let staged = officeRenderHostDir(stage);
  if (staged != "") {
    return officeTextFailed(staged);
  }
  let decoded = officeRenderDecode(stage, inExt, body);
  if (decoded != "") {
    officeRenderDrop(stage);
    return officeTextFailed(decoded);
  }

  let container = "agents-render-" + officeRenderDigits(now) + "-" + `${officeRenderSeq}`;
  let made = officeRenderDocker(officeTextRunArgs(container));
  if (made.status != 0) {
    officeRenderDrop(stage);
    return officeTextFailed("the document reader could not start ("
      + officeRenderImage() + " — is it built?)");
  }

  let out = officeTextInside(container, stage, inExt, command);
  officeRenderDocker(["rm", "-f", container]);
  officeRenderDrop(stage);
  return out;
}

export function officeText(db: Db, ask: OfficeRenderAsk): OfficeTexted {
  let ext = officeTextExt(ask.path);
  if (ext == "") {
    return officeTextRefused("only .pdf, .docx, .xlsx and .pptx can be read as text");
  }
  if (ask.artifactId == "" || ask.version < 1) {
    return officeTextRefused("reading a document names it and its version");
  }
  if (ask.body == "") {
    return officeTextRefused("this version has no body to read");
  }

  let held = officeTextCached(db, ask.artifactId, ask.version);
  if (held == "") {
    held = officeCachedBytes(db, officeBytesKey(ask.body) + ":text");
  }
  if (held != "") {
    let hit: OfficeTexted = { ok: true, text: held, cached: true, fault: "" };
    return hit;
  }

  let inExt = "pdf";
  let bytes = ask.body;
  if (ext == "xlsx" || ext == "docx") {
    inExt = ext;
  } else if (ext != "pdf") {
    let drawn = officeRender(db, ask);
    if (!drawn.ok) {
      return officeTextRefused(drawn.fault);
    }
    bytes = drawn.body;
  }

  let run = officeTextRun(inExt, bytes, officeTextCommand(ext), ask.now);
  if (!run.ok) {
    return officeTextRefused(run.fault);
  }
  let text = officeTextCapped(run.text);
  if (text.trim() == "") {
    return officeTextRefused("this document holds no text — a scan is pictures of words,"
      + " and nothing here reads pictures");
  }
  officeTextStore(db, ask.artifactId, ask.version, text, ask.now);
  officeStoreBytes(db, officeBytesKey(ask.body) + ":text", text, ask.now);
  let done: OfficeTexted = { ok: true, text: text, cached: false, fault: "" };
  return done;
}

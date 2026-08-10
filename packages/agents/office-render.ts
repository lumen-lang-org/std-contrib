import { Db } from "../plume/driver.ts";
import { findById, persist } from "../plume/plume.ts";
import { EnvDockerReply, envDockerBin } from "./environments.ts";
import { OfficeRenderRow, officeRendersMapping } from "./schema.ts";

export const OFFICE_RENDER_IMAGE: string = "agents-office-render:1";

const OFFICE_RENDER_SECONDS: int = 120;

const OFFICE_RENDER_MAX: int = 12000000;

let officeRenderChosenImage: string = "";

export function officeRenderImageOverride(image: string): void {
  officeRenderChosenImage = image;
}

export function officeRenderImage(): string {
  if (officeRenderChosenImage != "") { return officeRenderChosenImage; }
  return process.env("AGENTS_OFFICE_RENDER_IMAGE") ?? OFFICE_RENDER_IMAGE;
}

export function officeRenderExt(path: string): string {
  let lower = path.toLowerCase();
  if (lower.endsWith(".docx")) { return "docx"; }
  if (lower.endsWith(".xlsx")) { return "xlsx"; }
  if (lower.endsWith(".pptx")) { return "pptx"; }
  return "";
}

export type OfficeRendered = {
  ok: bool,
  body: string,
  cached: bool,
  problem: string,
};

function officeRenderRefused(why: string): OfficeRendered {
  let out: OfficeRendered = { ok: false, body: "", cached: false, problem: why };
  return out;
}

function officeRenderDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function officeRenderRunArgs(container: string): string[] {
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

function officeRenderCommand(ext: string): string {
  return "cd /work && HOME=/work XDG_CACHE_HOME=/work"
    + " timeout " + `${OFFICE_RENDER_SECONDS}`
    + " soffice --headless --norestore --nolockcheck"
    + " -env:UserInstallation=file:///work/lo"
    + " --convert-to pdf --outdir /work /work/in." + ext
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
    if (c >= 48 && c <= 57) { out = out + now.charAt(i); }
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
    if (fs.existsSync(dir)) { fs.rmSync(dir, true); }
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
  if (enc.status != 0) { return ""; }
  return enc.stdout.trim();
}

function officeRenderKey(artifactId: string, version: int): string {
  return artifactId + ":" + `${version}`;
}

export function officeRenderCached(db: Db, artifactId: string, version: int): string {
  let held = findById(db, officeRendersMapping(), officeRenderKey(artifactId, version));
  if (held == "") { return ""; }
  let row = JSON.parse<OfficeRenderRow>(held);
  return row.body;
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
  if (held != "") {
    let hit: OfficeRendered = { ok: true, body: held, cached: true, problem: "" };
    return hit;
  }

  let stage = officeRenderStage(ask.now);
  let staged = officeRenderHostDir(stage);
  if (staged != "") { return officeRenderRefused(staged); }
  let decoded = officeRenderDecode(stage, ext, ask.body);
  if (decoded != "") {
    officeRenderDrop(stage);
    return officeRenderRefused(decoded);
  }

  let container = "agents-render-" + officeRenderDigits(ask.now) + "-" + `${officeRenderSeq}`;
  let made = officeRenderDocker(officeRenderRunArgs(container));
  if (made.status != 0) {
    officeRenderDrop(stage);
    return officeRenderRefused("the document converter could not start ("
      + officeRenderImage() + " — is it built?)");
  }

  let out = officeRenderConvert(db, container, stage, ext, ask);
  officeRenderDocker(["rm", "-f", container]);
  officeRenderDrop(stage);
  return out;
}

function officeRenderConvert(db: Db, container: string, stage: string, ext: string, ask: OfficeRenderAsk): OfficeRendered {
  let placed = officeRenderDocker(["cp", stage + "/in." + ext, container + ":/work/in." + ext]);
  if (placed.status != 0) {
    return officeRenderRefused("the document could not be handed to the converter");
  }
  let ran = officeRenderDocker(["exec", "--user", "65534:65534", container,
    "sh", "-c", officeRenderCommand(ext)]);
  if (ran.status != 0) {
    if (ran.status == 124) {
      return officeRenderRefused("this document took longer than "
        + `${OFFICE_RENDER_SECONDS}` + " seconds to convert, so it was stopped");
    }
    return officeRenderRefused("this document could not be converted — it may be corrupt");
  }
  let back = officeRenderDocker(["cp", container + ":/work/in.pdf", stage + "/out.pdf"]);
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
  let done: OfficeRendered = { ok: true, body: b64, cached: false, problem: "" };
  return done;
}

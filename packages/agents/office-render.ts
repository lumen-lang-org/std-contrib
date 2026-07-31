// Office documents, converted to PDF by the platform.
//
// A .docx, .xlsx or .pptx is a layout problem, and the console used to solve
// it twice in JavaScript — docx-preview for documents, pptx-preview for
// decks. Both are re-implementations of a layout engine, both are honest
// about degrading on charts, SmartArt and real typography, and neither can
// ever be more right than the engine they are imitating. This module calls
// the engine instead: one LibreOffice conversion, one PDF, one renderer in
// the browser, and the same path serves all three formats.
//
//   cd packages/agents && lumen test office-render.test.ts
//
// The three rules this file exists to keep:
//
// 1. **It is not a script environment.** No conversation names it, no agent
//    reaches it, nothing a model writes runs in it. environments.ts hands
//    containers to conversations; this hands a container to nobody. They look
//    alike and are opposite in who is trusted.
//
// 2. **One container per conversion, removed after.** LibreOffice is parsing
//    a file this platform did not write, and its history of malformed-input
//    CVEs is long. A container that survived one document would carry
//    whatever that document managed into the next reader's conversion; a
//    fresh one cannot. The cost is a cold start, and the cache below means it
//    is paid once per document version, ever.
//
// 3. **The cache key is immutable, so there is no invalidation.** An artifact
//    version is append-only — `<artifactId>:<version>` names bytes that can
//    never change — so a stored render is true forever. That is what makes
//    the cold start affordable and why nothing here compares hashes.
//
// The boundary with the store is base64, like every binary body in this
// package: a Lumen string is UTF-8 and a PDF is not, so bytes exist only
// inside the container and inside the staging directory, never in a variable.

import { Db } from "../plume/driver.ts";
import { findById, persist } from "../plume/plume.ts";
import { EnvDockerReply, envDockerBin } from "./environments.ts";
import { OfficeRenderRow, officeRendersMapping } from "./schema.ts";

// The image the conversion runs in. Built from office-render.Dockerfile:
//
//   docker build -f office-render.Dockerfile -t agents-office-render:1 .
//
// Overridable so an operator can pin their own build, and so a test can point
// at something small that is not LibreOffice.
export const OFFICE_RENDER_IMAGE: string = "agents-office-render:1";

// How long a conversion may take before it is killed, in seconds. Enforced by
// `timeout` INSIDE the container, not out here: `spawnSync` has no timeout
// parameter, so a hang would otherwise block the request thread until
// LibreOffice gave up on its own, which for some malformed inputs is never.
const OFFICE_RENDER_SECONDS: int = 120;

// The largest PDF worth carrying, as base64 bytes. A conversion is answered
// over JSON and held in memory whole, so this is the ceiling on both. ~12MB
// of base64 is ~9MB of PDF — past that the honest answer is "download the
// file", not a preview that costs the engine a request's worth of heap.
const OFFICE_RENDER_MAX: int = 12000000;

let officeRenderChosenImage: string = "";

// Tests cannot set an environment variable from inside the process, so the
// override is a module-level setting — the same shape `envDockerOverride`
// uses, for the same reason.
export function officeRenderImageOverride(image: string): void {
  officeRenderChosenImage = image;
}

export function officeRenderImage(): string {
  if (officeRenderChosenImage != "") { return officeRenderChosenImage; }
  return process.env("AGENTS_OFFICE_RENDER_IMAGE") ?? OFFICE_RENDER_IMAGE;
}

// --- what can be converted --------------------------------------------------------

// The extension a conversion accepts, or "" for a path it will not touch.
//
// Deliberately a fixed list rather than "anything LibreOffice can open". It
// opens a great deal — including formats with macro and external-reference
// semantics nobody here has thought about — and the door being narrow is a
// security property, not a limitation to relax when someone asks for .odt.
// Widening it means deciding, per format, that feeding it to a converter is
// safe; the list is short because that thinking is per-entry.
export function officeRenderExt(path: string): string {
  let lower = path.toLowerCase();
  if (lower.endsWith(".docx")) { return "docx"; }
  if (lower.endsWith(".xlsx")) { return "xlsx"; }
  if (lower.endsWith(".pptx")) { return "pptx"; }
  return "";
}

// --- the reply --------------------------------------------------------------------

export type OfficeRendered = {
  ok: bool,
  // The PDF, base64. Empty when ok is false.
  body: string,
  // Whether this answer came from the cache rather than a conversion. Carried
  // so a caller can log the cold path without timing it.
  cached: bool,
  problem: string,
};

function officeRenderRefused(why: string): OfficeRendered {
  let out: OfficeRendered = { ok: false, body: "", cached: false, problem: why };
  return out;
}

// --- docker -----------------------------------------------------------------------

// The one door to docker, same rule as envDocker and scriptDocker: an
// argument vector, never a shell string, so nothing derived from an artifact
// path or a thread id can be quoted into a command.
function officeRenderDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

// The container a conversion runs in, and everything that keeps it contained.
//
// Every restriction here is one environments.ts also applies, minus the ones
// that exist because a script environment has a person behind it wanting to
// install things. The differences are the point:
//
//   --network none      always, not conditionally. A converter has nothing to
//                       fetch and nothing to tell. environments.ts makes this
//                       a row value because an installer needs a network; a
//                       conversion never does, so it is not a parameter.
//   --cap-drop ALL      with nothing added back. environments.ts restores five
//                       capabilities for apt and pip; LibreOffice reading one
//                       file and writing another needs none of them. This is
//                       also why /work is prepared in the image rather than
//                       here: without CHOWN, a container cannot give its own
//                       run user a directory.
//
// Two restrictions that look right and are not, both established by trying
// them. `--read-only` cannot be used: `docker cp` refuses outright on a
// container whose rootfs is marked read-only — before it resolves the
// destination, so a writable mount at the target does not rescue it — and the
// conversion then runs against a document that was never delivered. `--tmpfs
// /work` cannot be used either: `docker cp` into a path covered by a tmpfs
// mount writes underneath the mount, so the file is invisible to the process
// that needs it. Both failures are silent, because LibreOffice exits 0 when
// its input is missing. What stands in for them is the container's lifetime:
// it is created for one document and destroyed after it, so its writable
// layer is as ephemeral as a tmpfs would have been and is shared with nobody.
//
// The entrypoint override is the trick environments.ts documents: `sleep
// infinity` gives docker something to keep alive so there is a container to
// `cp` into and `exec` in. Without it the image would have to be run as a
// program, and there would be no way to get the bytes in.
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

// The conversion, as a shell line run inside the container.
//
// A shell is used here — unlike everywhere else in this package — because the
// command genuinely needs redirection, and every word in it is a constant
// written above. Nothing from an artifact, a path or a caller reaches this
// string: the input is always /work/in.<ext> and the output always
// /work/in.pdf, with the real path left behind in the staging directory. That
// renaming is not tidiness — it is what makes this line have no variables in
// it worth attacking.
//
// The three environment settings are each a failure that was hit. HOME,
// because the run user's home is /nonexistent and dconf aborts on it.
// XDG_CACHE_HOME, because fontconfig answers "No writable cache directories"
// otherwise and re-scans every font on every conversion — the fonts still
// resolve, they are just paid for each time. -env:UserInstallation, because
// LibreOffice refuses to start at all without a writable profile: "The
// application cannot be started. User installation could not be completed."
//
// stderr goes to /dev/null deliberately: `spawnSync` reads stdout to
// completion before it reads stderr, so a process that fills the stderr pipe
// while this is blocked on stdout would deadlock (documented in Lumen's
// child_process spec). LibreOffice is chatty on stderr about fonts and
// javaldx. The exit status is what this call reads, and that survives.
function officeRenderCommand(ext: string): string {
  return "cd /work && HOME=/work XDG_CACHE_HOME=/work"
    + " timeout " + `${OFFICE_RENDER_SECONDS}`
    + " soffice --headless --norestore --nolockcheck"
    + " -env:UserInstallation=file:///work/lo"
    + " --convert-to pdf --outdir /work /work/in." + ext
    + " >/dev/null 2>&1";
}

// --- staging ----------------------------------------------------------------------

// A conversion's own directory under /tmp on the host. Named from the clock
// and a counter rather than randomly, so two conversions in the same
// millisecond still get their own.
let officeRenderSeq: int = 0;

function officeRenderStage(now: string): string {
  officeRenderSeq = officeRenderSeq + 1;
  return "/tmp/agents-render-" + officeRenderDigits(now) + "-" + `${officeRenderSeq}`;
}

// The digits of a stamp, so a malformed clock cannot put a path separator or
// a shell character into a directory name.
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

// The stored base64 body, written to the staging directory as real bytes.
//
// Decoded through `sh` only because `base64 -d` reads stdin and there is no
// other way to redirect a file into it — the same reason and the same shape
// as run-script's placeFile. Both paths in the line are ours and constant.
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

// The PDF the container produced, back as base64. `base64 -w0` through an
// argv vector, no shell — the same call run-script uses to carry a raster
// file out of a run directory.
function officeRenderEncode(path: string): string {
  let enc = child_process.spawnSync("base64", ["-w0", path]);
  if (enc.status != 0) { return ""; }
  return enc.stdout.trim();
}

// --- the cache --------------------------------------------------------------------

// The key: the artifact and the version, which together name bytes that can
// never change. See the note on OfficeRenderRow — this is why nothing here
// ever has to decide whether a cached render is stale.
function officeRenderKey(artifactId: string, version: int): string {
  return artifactId + ":" + `${version}`;
}

// The stored PDF for a version, or "" for one that has not been converted.
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

// --- the conversion ---------------------------------------------------------------

export type OfficeRenderAsk = {
  artifactId: string,
  version: int,
  // The artifact's path, which decides the format. Only its extension is
  // read; the name never reaches the container.
  path: string,
  // The stored body: base64, because every office artifact is a binary kind.
  body: string,
  now: string,
};

// The PDF for one artifact version — from the cache when it has been
// converted before, from LibreOffice when it has not.
//
// Every failure is a sentence rather than an exception, matching run-script
// and environments: a caller here is answering a request, and "docker is not
// running" is an answer a reader can act on where a 500 is not.
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
    // The usual causes are a daemon that is not running and an image that was
    // never built, and both are an operator's problem rather than a reader's
    // — so the sentence names the image, which is the actionable half.
    return officeRenderRefused("the document converter could not start ("
      + officeRenderImage() + " — is it built?)");
  }

  let out = officeRenderConvert(db, container, stage, ext, ask);
  // The container goes whatever happened. This is the guarantee rule 2 rests
  // on: not "removed on success", removed.
  officeRenderDocker(["rm", "-f", container]);
  officeRenderDrop(stage);
  return out;
}

// The middle of a conversion, with the container up and the bytes staged.
// Split out so `officeRender` above has exactly one place that removes the
// container and drops the staging directory, rather than a copy of that pair
// on each of the five ways this can fail.
function officeRenderConvert(db: Db, container: string, stage: string, ext: string, ask: OfficeRenderAsk): OfficeRendered {
  // `docker cp` rather than a bind mount, and not for convenience: cp is
  // performed by the CLI and streamed over the API, so it works when the
  // engine is itself in a container and the daemon's filesystem is not the
  // engine's. A `-v /tmp/...` would be resolved on the daemon's host, find
  // nothing, and silently mount an empty directory. run-script learned this
  // first; the rule is the same here.
  let placed = officeRenderDocker(["cp", stage + "/in." + ext, container + ":/work/in." + ext]);
  if (placed.status != 0) {
    return officeRenderRefused("the document could not be handed to the converter");
  }
  // Unprivileged inside an already unprivileged container. `docker cp` leaves
  // the file owned by root and mode 0644, which nobody can read but not
  // write — which is all a conversion needs of its input.
  let ran = officeRenderDocker(["exec", "--user", "65534:65534", container,
    "sh", "-c", officeRenderCommand(ext)]);
  if (ran.status != 0) {
    // A timeout exits 124 through `timeout`, and it is worth its own sentence
    // — an operator reading "could not be converted" would go looking for a
    // broken image when the truth is a document that takes too long.
    if (ran.status == 124) {
      return officeRenderRefused("this document took longer than "
        + `${OFFICE_RENDER_SECONDS}` + " seconds to convert, so it was stopped");
    }
    return officeRenderRefused("this document could not be converted — it may be corrupt");
  }
  let back = officeRenderDocker(["cp", container + ":/work/in.pdf", stage + "/out.pdf"]);
  if (back.status != 0) {
    // LibreOffice exits 0 having written nothing when a filter declines the
    // file — a .docx that is really a .zip of something else is the common
    // case — so the missing output is the real check, not the exit status.
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

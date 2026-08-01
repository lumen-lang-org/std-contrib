// The ceilings, and the one place that names them.
//
//   export const ARTIFACT_MAX: int = artifactBytesMax();   // artifacts.ts
//
// Every number here was a compile-time constant, which made "how big may an
// upload be on this box" a question answered by rebuilding the binary. They
// are read from the environment now, and the fallback is the number the
// constant held — so an operator who sets nothing gets bit-for-bit what this
// served before, and a cloud tier that wants a different budget is a unit-file
// edit rather than a fork.
//
// One module rather than three private readers, because these numbers are
// documentation as much as configuration: an operator sizing a box wants the
// whole list, and a list spread over three files grows a fourth entry nobody
// documents. The constants themselves stay where they are enforced — a cap is
// only meaningful beside the door it closes.
//
// The engine enforces the same limits for everyone. Per-tenant quotas are the
// control plane's business, fed by `GET /usage` (GATEWAY.md); nothing here
// knows what a tenant is.
//
//   cd packages/agents && lumen test caps.test.ts

// A byte count from the environment, or the fallback.
//
// Anything unreadable is the fallback rather than a refusal to start: this is
// read while the module initialises, before there is a logger or an exit code
// worth anything, and a typo in a unit file should leave the engine at its
// documented default instead of dead. Zero and negatives go the same way —
// "0" as "nothing may be written" is a way to brick a deployment by shell
// quoting, and no operator means it.
export function bytesCap(said: string, fallback: int): int {
  let text = said.trim();
  if (text == "") { return fallback; }
  // Digits and nothing else, checked before parsing rather than after:
  // `parseInt` reads the leading number and drops the rest, so "512MB" — the
  // first thing anyone writes here — would have meant five hundred and twelve
  // bytes, and every artifact would be refused with a number the operator
  // believed they had multiplied.
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) { return fallback; }
    i = i + 1;
  }
  let n = parseInt(text, 10) ?? fallback;
  if (n < 1) { return fallback; }
  return n;
}

// The largest body one artifact may carry. Half a megabyte is far more than a
// page a person reads and far less than a database row anyone should hold in
// memory to serve one preview.
export function artifactBytesMax(): int {
  return bytesCap(process.env("AGENTS_ARTIFACT_BYTES_MAX") ?? "", 524288);
}

// Everything one conversation's artifacts hold, across every version of every
// one of them — versions are append-only, so old bodies count too.
export function threadBytesMax(): int {
  return bytesCap(process.env("AGENTS_THREAD_BYTES_MAX") ?? "", 104857600);
}

// The largest body one workspace file may carry.
//
// This door had no cap at all: `POST /threads/:id/files` took whatever JSON
// arrived and `write_file` took whatever the model produced, both straight
// into a text column. One megabyte is the first number that is still a file
// rather than a dataset — anything larger belongs in the corpus, which chunks
// it, rather than in a workspace, where `read_file` hands the whole body to a
// model in one go.
export function uploadBytesMax(): int {
  return bytesCap(process.env("AGENTS_UPLOAD_BYTES_MAX") ?? "", 1048576);
}

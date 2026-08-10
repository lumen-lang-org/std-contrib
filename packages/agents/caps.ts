export function bytesCap(said: string, fallback: int): int {
  let text = said.trim();
  if (text == "") {
    return fallback;
  }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) {
      return fallback;
    }
    i = i + 1;
  }
  let n = parseInt(text, 10) ?? fallback;
  if (n < 1) {
    return fallback;
  }
  return n;
}

export function artifactBytesMax(): int {
  return bytesCap(process.env("AGENTS_ARTIFACT_BYTES_MAX") ?? "", 524288);
}

export function threadBytesMax(): int {
  return bytesCap(process.env("AGENTS_THREAD_BYTES_MAX") ?? "", 104857600);
}

export function uploadBytesMax(): int {
  return bytesCap(process.env("AGENTS_UPLOAD_BYTES_MAX") ?? "", 1048576);
}

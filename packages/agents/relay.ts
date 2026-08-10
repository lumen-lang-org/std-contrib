let lastNudge: number = 0;

let coolUntil: number = 0;

const NUDGE_GAP_MS: number = 80;
const COOLOFF_MS: number = 30000;

export function nudgeConsoles(): void {
  let targets = process.env("AGENTS_CONSOLE_NUDGE") ?? "";
  if (targets == "") { return; }
  let now = Date.now();
  if (now < coolUntil) { return; }
  if (now - lastNudge < NUDGE_GAP_MS) { return; }
  lastNudge = now;

  let list = targets.split(",");
  let failed = false;
  let i: int = 0;
  while (i < list.length) {
    let url = list[i].trim();
    if (url != "") {
      let res = http.request(url, "POST", "", new Map<string, string>());
      if (!res.ok || res.status != 204) { failed = true; }
    }
    i = i + 1;
  }
  if (failed) { coolUntil = now + COOLOFF_MS; }
}

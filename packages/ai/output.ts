// Output parser helpers.

export function parseTextOutput(raw: string): string {
  return raw;
}

function isOutputSpace(c: string): bool {
  return c == " " || c == "\t" || c == "\r";
}

function trimOutputSpaces(s: string): string {
  let start: int = 0;
  let end: int = s.length;
  while (start < end && isOutputSpace(s.charAt(start))) { start = start + 1; }
  while (end > start && isOutputSpace(s.charAt(end - 1))) { end = end - 1; }
  return s.substring(start, end);
}

function isOutputDigit(c: string): bool {
  return c.charCodeAt(0) >= "0".charCodeAt(0) && c.charCodeAt(0) <= "9".charCodeAt(0);
}

function findOutputFrom(src: string, pattern: string, start: int): int {
  let i = start;
  while (i + pattern.length <= src.length) {
    if (src.substring(i, i + pattern.length) == pattern) { return i; }
    i = i + 1;
  }
  return -1;
}

function stripListMarker(line: string): string {
  let s = trimOutputSpaces(line);
  if (s.startsWith("- ") || s.startsWith("* ")) {
    return trimOutputSpaces(s.substring(2, s.length));
  }
  let i: int = 0;
  while (i < s.length && isOutputDigit(s.charAt(i))) { i = i + 1; }
  if (i > 0 && i + 1 < s.length && s.charAt(i) == "." && s.charAt(i + 1) == " ") {
    return trimOutputSpaces(s.substring(i + 2, s.length));
  }
  return s;
}

export function parseLineOutput(raw: string): string[] {
  if (raw == "") {
    let empty: string[] = [];
    return empty;
  }
  return raw.split("\n");
}

export function parseStringListOutput(raw: string): string[] {
  let lines = parseLineOutput(raw);
  let out = "";
  for (const line of lines) {
    let item = stripListMarker(line);
    if (item != "") {
      if (out != "") { out = out + "\n"; }
      out = out + item;
    }
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

// True when `text` holds `needle` as a whole word — the characters on either
// side must not be letters or digits. Substring matching alone would let the
// choice "no" match inside "I don't know".
function choiceWordAt(text: string, needle: string): bool {
  if (needle.length == 0) { return false; }
  let i: int = 0;
  while (i + needle.length <= text.length) {
    if (text.slice(i, i + needle.length) == needle) {
      let beforeOk: bool = i == 0;
      if (!beforeOk) { beforeOk = !isChoiceWordChar(text.charAt(i - 1)); }
      let afterAt = i + needle.length;
      let afterOk: bool = afterAt >= text.length;
      if (!afterOk) { afterOk = !isChoiceWordChar(text.charAt(afterAt)); }
      if (beforeOk && afterOk) { return true; }
    }
    i = i + 1;
  }
  return false;
}

function isChoiceWordChar(c: string): bool {
  if (c.length == 0) { return false; }
  let code = c.charCodeAt(0);
  if (code >= "a".charCodeAt(0) && code <= "z".charCodeAt(0)) { return true; }
  if (code >= "A".charCodeAt(0) && code <= "Z".charCodeAt(0)) { return true; }
  if (code >= "0".charCodeAt(0) && code <= "9".charCodeAt(0)) { return true; }
  return code >= 128;
}

// Pick one allowed choice out of a model's reply. Models rarely answer with the
// bare token: "Compiled", "Compiled." and "Lumen is compiled." are all the same
// answer, so matching is case-insensitive and looks for the choice as a whole
// word rather than demanding an exact string. Longer choices are preferred so
// overlapping options ("yes" vs "yes, always") resolve to the specific one.
export function parseChoiceOutput(raw: string, choices: string[], fallback: string): string {
  let value = trimOutputSpaces(raw).toLowerCase();
  // Exact match first, so an unambiguous reply never depends on word scanning.
  for (const choice of choices) {
    if (value == choice.toLowerCase()) { return choice; }
  }
  let best = fallback;
  let bestLen: int = 0;
  for (const choice of choices) {
    let lowered = choice.toLowerCase();
    if (lowered.length > bestLen && choiceWordAt(value, lowered)) {
      best = choice;
      bestLen = lowered.length;
    }
  }
  return best;
}

export function firstFencedBlockOutput(raw: string): string {
  let start = raw.indexOf("```");
  if (start < 0) { return ""; }
  let afterStart = start + 3;
  let end = findOutputFrom(raw, "```", afterStart);
  if (end < 0) { return ""; }
  let contentStart = afterStart;
  let firstNewline = findOutputFrom(raw, "\n", afterStart);
  if (firstNewline >= 0 && firstNewline < end) {
    contentStart = firstNewline + 1;
  }
  let contentEnd = end;
  if (contentEnd > contentStart && raw.charAt(contentEnd - 1) == "\n") {
    contentEnd = contentEnd - 1;
  }
  return raw.substring(contentStart, contentEnd);
}

export function firstJsonObjectOutput(raw: string): string {
  let start: int = -1;
  let depth: int = 0;
  let inString: bool = false;
  let escaped: bool = false;
  let i: int = 0;
  while (i < raw.length) {
    let c = raw.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == "\\") {
        escaped = true;
      } else if (c == "\"") {
        inString = false;
      }
    } else if (c == "\"") {
      inString = true;
    } else if (c == "{") {
      if (depth == 0) { start = i; }
      depth = depth + 1;
    } else if (c == "}") {
      if (depth > 0) {
        depth = depth - 1;
        if (depth == 0 && start >= 0) {
          return raw.substring(start, i + 1);
        }
      }
    }
    i = i + 1;
  }
  return "";
}

export function typedJsonInputOutput(raw: string): string {
  let fenced = firstFencedBlockOutput(raw);
  if (fenced != "") {
    let fencedJson = firstJsonObjectOutput(fenced);
    if (fencedJson != "") { return fencedJson; }
    return fenced;
  }
  let json = firstJsonObjectOutput(raw);
  if (json != "") { return json; }
  return raw;
}

export function retryPromptOutput(instruction: string, invalidOutput: string, errorMessage: string): string {
  return instruction + "\n\nPrevious output was invalid:\n" + invalidOutput + "\n\nReason:\n" + errorMessage + "\n\nReturn only corrected output.";
}

test("parseChoice tolerates real model phrasing", () => {
  let choices: string[] = ["compiled", "interpreted"];
  expect(parseChoiceOutput("compiled", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Compiled", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Compiled.", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("Lumen is compiled.", choices, "unknown") == "compiled");
  expect(parseChoiceOutput("  INTERPRETED  ", choices, "unknown") == "interpreted");
  expect(parseChoiceOutput("neither, really", choices, "unknown") == "unknown");
});

test("parseChoice does not match a choice inside a longer word", () => {
  let yn: string[] = ["yes", "no"];
  // "no" must not match inside "know"
  expect(parseChoiceOutput("I don't know", yn, "unknown") == "unknown");
  expect(parseChoiceOutput("No.", yn, "unknown") == "no");
  expect(parseChoiceOutput("nobody", yn, "unknown") == "unknown");
});

test("parseChoice prefers the longer overlapping choice", () => {
  let opts: string[] = ["yes", "yes always"];
  expect(parseChoiceOutput("yes always", opts, "unknown") == "yes always");
  expect(parseChoiceOutput("yes", opts, "unknown") == "yes");
});

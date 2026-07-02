// dotenv -- small .env parser, written entirely in Lumen.
//
// Pure parser only: no filesystem access and no process environment mutation.
// Run: lumen test packages/dotenv/dotenv.ts

function isSpace(c: string): bool {
  return c == " " || c == "\t" || c == "\r";
}

function trimSpaces(s: string): string {
  let start: int = 0;
  let end: int = s.length;
  while (start < end && isSpace(s.charAt(start))) { start = start + 1; }
  while (end > start && isSpace(s.charAt(end - 1))) { end = end - 1; }
  return s.substring(start, end);
}

function validKey(key: string): bool {
  if (key == "") { return false; }
  let i: int = 0;
  while (i < key.length) {
    let c = key.charAt(i);
    let ok = c == "_" || c == "." || c == "-" ||
      (c.charCodeAt(0) >= "0".charCodeAt(0) && c.charCodeAt(0) <= "9".charCodeAt(0)) ||
      (c.charCodeAt(0) >= "a".charCodeAt(0) && c.charCodeAt(0) <= "z".charCodeAt(0)) ||
      (c.charCodeAt(0) >= "A".charCodeAt(0) && c.charCodeAt(0) <= "Z".charCodeAt(0));
    if (!ok) { return false; }
    i = i + 1;
  }
  return true;
}

function findEquals(line: string): int {
  let i: int = 0;
  while (i < line.length) {
    if (line.charAt(i) == "=") { return i; }
    i = i + 1;
  }
  return -1;
}

function stripInlineComment(s: string): string {
  let i: int = 0;
  while (i < s.length) {
    if (s.charAt(i) == "#") {
      if (i == 0 || isSpace(s.charAt(i - 1))) {
        return trimSpaces(s.substring(0, i));
      }
    }
    i = i + 1;
  }
  return trimSpaces(s);
}

function unescapeDoubleQuoted(s: string): string {
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\\" && i + 1 < s.length) {
      let n = s.charAt(i + 1);
      if (n == "n") { out = out + "\n"; }
      else if (n == "r") { out = out + "\r"; }
      else if (n == "t") { out = out + "\t"; }
      else if (n == "\"") { out = out + "\""; }
      else if (n == "\\") { out = out + "\\"; }
      else { out = out + n; }
      i = i + 2;
    } else {
      out = out + c;
      i = i + 1;
    }
  }
  return out;
}

function parseValue(raw: string): string {
  let s = trimSpaces(raw);
  if (s.length >= 2 && s.charAt(0) == "\"" && s.charAt(s.length - 1) == "\"") {
    return unescapeDoubleQuoted(s.substring(1, s.length - 1));
  }
  if (s.length >= 2 && s.charAt(0) == "'" && s.charAt(s.length - 1) == "'") {
    return s.substring(1, s.length - 1);
  }
  return stripInlineComment(s);
}

function parseLine(line: string): string {
  let t = trimSpaces(line);
  if (t == "" || t.startsWith("#")) { return ""; }
  if (t.startsWith("export ")) { t = trimSpaces(t.substring(7, t.length)); }
  let eq = findEquals(t);
  if (eq < 0) { return ""; }
  let key = trimSpaces(t.substring(0, eq));
  if (!validKey(key)) { return ""; }
  return key + "=" + parseValue(t.substring(eq + 1, t.length));
}

export function parse(src: string): string[] {
  let lines = src.split("\n");
  let out = "";
  for (const line of lines) {
    let entry = parseLine(line);
    if (entry != "") {
      if (out != "") { out = out + "\n"; }
      out = out + entry;
    }
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

function entryKey(entry: string): string {
  let eq = findEquals(entry);
  if (eq < 0) { return ""; }
  return entry.substring(0, eq);
}

function entryValue(entry: string): string {
  let eq = findEquals(entry);
  if (eq < 0) { return ""; }
  return entry.substring(eq + 1, entry.length);
}

export function get(src: string, key: string, fallback: string): string {
  let entries = parse(src);
  let value = fallback;
  for (const entry of entries) {
    if (entryKey(entry) == key) { value = entryValue(entry); }
  }
  return value;
}

export function has(src: string, key: string): bool {
  let entries = parse(src);
  for (const entry of entries) {
    if (entryKey(entry) == key) { return true; }
  }
  return false;
}

test("parse key value pairs", () => {
  let env = "PORT=3000\nAPP_MODE=production\nEMPTY=\n";
  let entries = parse(env);
  expect(entries.length == 3);
  expect(entries[0] == "PORT=3000");
  expect(entries[1] == "APP_MODE=production");
  expect(entries[2] == "EMPTY=");
});

test("comments and whitespace", () => {
  let env = " # comment\n PORT = 3000  # server port\nTOKEN=abc#123\n";
  let entries = parse(env);
  expect(entries.length == 2);
  expect(entries[0] == "PORT=3000");
  expect(entries[1] == "TOKEN=abc#123");
});

test("quoted values", () => {
  let env = "A=\"hello world\"\nB='literal # hash'\n";
  expect(get(env, "A", "") == "hello world");
  expect(get(env, "B", "") == "literal # hash");
});

test("export prefix and duplicate keys", () => {
  let env = "export PORT=3000\nPORT=4000\n";
  expect(has(env, "PORT"));
  expect(get(env, "PORT", "0") == "4000");
  expect(get(env, "MISSING", "fallback") == "fallback");
});

test("invalid and blank lines are ignored", () => {
  let env = "\nNO_EQUALS\nBAD KEY=value\nOK=yes\n";
  let entries = parse(env);
  expect(entries.length == 1);
  expect(entries[0] == "OK=yes");
});

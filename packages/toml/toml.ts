// toml -- practical TOML config reader, written entirely in Lumen.
//
// V1 focuses on common config-file reads: sections, dotted keys, strings,
// integers, booleans, and simple arrays. No filesystem access.
// Run: lumen test packages/toml/toml.ts

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

function isDigit(c: string): bool {
  let x = c.charCodeAt(0);
  return x >= "0".charCodeAt(0) && x <= "9".charCodeAt(0);
}

function validBareKeyPart(part: string): bool {
  if (part == "") { return false; }
  let i: int = 0;
  while (i < part.length) {
    let c = part.charAt(i);
    let x = c.charCodeAt(0);
    let ok = c == "_" || c == "-" ||
      (x >= "0".charCodeAt(0) && x <= "9".charCodeAt(0)) ||
      (x >= "a".charCodeAt(0) && x <= "z".charCodeAt(0)) ||
      (x >= "A".charCodeAt(0) && x <= "Z".charCodeAt(0));
    if (!ok) { return false; }
    i = i + 1;
  }
  return true;
}

function validDottedKey(key: string): bool {
  let parts = key.split(".");
  for (const part of parts) {
    if (!validBareKeyPart(trimSpaces(part))) { return false; }
  }
  return true;
}

function normalizeDottedKey(key: string): string {
  let parts = key.split(".");
  let out = "";
  for (const part of parts) {
    if (out != "") { out = out + "."; }
    out = out + trimSpaces(part);
  }
  return out;
}

function findUnquoted(line: string, needle: string): int {
  let inSingle: bool = false;
  let inDouble: bool = false;
  let escape: bool = false;
  let i: int = 0;
  while (i < line.length) {
    let c = line.charAt(i);
    if (inDouble && escape) {
      escape = false;
    } else if (inDouble && c == "\\") {
      escape = true;
    } else if (!inSingle && c == "\"") {
      inDouble = !inDouble;
    } else if (!inDouble && c == "'") {
      inSingle = !inSingle;
    } else if (!inSingle && !inDouble && c == needle) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

function stripComment(line: string): string {
  let i = findUnquoted(line, "#");
  if (i < 0) { return trimSpaces(line); }
  return trimSpaces(line.substring(0, i));
}

function unescapeBasicString(s: string): string {
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\\" && i + 1 < s.length) {
      let n = s.charAt(i + 1);
      if (n == "\"") { out = out + "\""; }
      else if (n == "\\") { out = out + "\\"; }
      else if (n == "t") { out = out + "\t"; }
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
  let s = stripComment(raw);
  if (s.length >= 2 && s.charAt(0) == "\"" && s.charAt(s.length - 1) == "\"") {
    return unescapeBasicString(s.substring(1, s.length - 1));
  }
  if (s.length >= 2 && s.charAt(0) == "'" && s.charAt(s.length - 1) == "'") {
    return s.substring(1, s.length - 1);
  }
  return s;
}

function sectionName(line: string): string {
  let t = stripComment(line);
  if (t.length < 3 || t.charAt(0) != "[" || t.charAt(t.length - 1) != "]") { return ""; }
  if (t.startsWith("[[")) { return ""; }
  let name = normalizeDottedKey(t.substring(1, t.length - 1));
  if (!validDottedKey(name)) { return ""; }
  return name;
}

function joinKey(section: string, key: string): string {
  let k = normalizeDottedKey(key);
  if (section == "") { return k; }
  return section + "." + k;
}

function parseLine(line: string, section: string): string {
  let t = stripComment(line);
  if (t == "" || t.startsWith("[")) { return ""; }
  let eq = findUnquoted(t, "=");
  if (eq < 0) { return ""; }
  let key = trimSpaces(t.substring(0, eq));
  if (!validDottedKey(key)) { return ""; }
  return joinKey(section, key) + "=" + parseValue(t.substring(eq + 1, t.length));
}

export function parse(src: string): string[] {
  let lines = src.split("\n");
  let section = "";
  let out = "";
  for (const line of lines) {
    let nextSection = sectionName(line);
    if (nextSection != "") {
      section = nextSection;
    } else {
      let entry = parseLine(line, section);
      if (entry != "") {
        if (out != "") { out = out + "\n"; }
        out = out + entry;
      }
    }
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

function findEquals(entry: string): int {
  let i: int = 0;
  while (i < entry.length) {
    if (entry.charAt(i) == "=") { return i; }
    i = i + 1;
  }
  return -1;
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

export function keys(src: string): string[] {
  let entries = parse(src);
  let out = "";
  for (const entry of entries) {
    if (out != "") { out = out + "\n"; }
    out = out + entryKey(entry);
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

export function has(src: string, key: string): bool {
  let entries = parse(src);
  for (const entry of entries) {
    if (entryKey(entry) == key) { return true; }
  }
  return false;
}

export function get(src: string, key: string, fallback: string): string {
  let entries = parse(src);
  let value = fallback;
  for (const entry of entries) {
    if (entryKey(entry) == key) { value = entryValue(entry); }
  }
  return value;
}

function parseIntValue(s: string, fallback: int): int {
  let t = trimSpaces(s);
  if (t == "") { return fallback; }
  let sign: int = 1;
  let i: int = 0;
  if (t.charAt(0) == "-") { sign = -1; i = 1; }
  if (i >= t.length) { return fallback; }
  let out: int = 0;
  while (i < t.length) {
    let c = t.charAt(i);
    if (c == "_") {
      i = i + 1;
    } else if (isDigit(c)) {
      out = out * 10 + (c.charCodeAt(0) - "0".charCodeAt(0));
      i = i + 1;
    } else {
      return fallback;
    }
  }
  return out * sign;
}

function isIntegerLiteral(s: string): bool {
  let t = trimSpaces(s);
  if (t == "") { return false; }
  let i: int = 0;
  if (t.charAt(0) == "-") { i = 1; }
  if (i >= t.length) { return false; }
  while (i < t.length) {
    let c = t.charAt(i);
    if (c != "_" && !isDigit(c)) { return false; }
    i = i + 1;
  }
  return true;
}

export function getInt(src: string, key: string, fallback: int): int {
  return parseIntValue(get(src, key, ""), fallback);
}

export function getBool(src: string, key: string, fallback: bool): bool {
  let v = get(src, key, "");
  if (v == "true") { return true; }
  if (v == "false") { return false; }
  return fallback;
}

export function getString(src: string, key: string, fallback: string): string {
  return get(src, key, fallback);
}

function splitArrayItems(raw: string): string[] {
  let s = trimSpaces(raw);
  if (s.length < 2 || s.charAt(0) != "[" || s.charAt(s.length - 1) != "]") {
    let empty: string[] = [];
    return empty;
  }
  let body = s.substring(1, s.length - 1);
  let out = "";
  let item = "";
  let inSingle: bool = false;
  let inDouble: bool = false;
  let escape: bool = false;
  let i: int = 0;
  while (i < body.length) {
    let c = body.charAt(i);
    if (inDouble && escape) {
      item = item + c;
      escape = false;
    } else if (inDouble && c == "\\") {
      escape = true;
    } else if (!inSingle && c == "\"") {
      inDouble = !inDouble;
      item = item + c;
    } else if (!inDouble && c == "'") {
      inSingle = !inSingle;
      item = item + c;
    } else if (!inSingle && !inDouble && c == ",") {
      let parsed = parseValue(item);
      if (out != "") { out = out + "\n"; }
      out = out + parsed;
      item = "";
    } else {
      item = item + c;
    }
    i = i + 1;
  }
  let last = trimSpaces(item);
  if (last != "") {
    let parsed = parseValue(last);
    if (out != "") { out = out + "\n"; }
    out = out + parsed;
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

export function getArray(src: string, key: string): string[] {
  return splitArrayItems(get(src, key, ""));
}

function escapeString(s: string): string {
  let out = "";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\"") { out = out + "\\\""; }
    else if (c == "\\") { out = out + "\\\\"; }
    else if (c == "\t") { out = out + "\\t"; }
    else { out = out + c; }
    i = i + 1;
  }
  return out;
}

function valueLiteral(value: string): string {
  let v = trimSpaces(value);
  if (v == "true" || v == "false") { return v; }
  if (isIntegerLiteral(v)) { return v; }
  if (v.startsWith("[") && v.endsWith("]")) { return v; }
  return "\"" + escapeString(v) + "\"";
}

function parentKey(key: string): string {
  let last: int = -1;
  let i: int = 0;
  while (i < key.length) {
    if (key.charAt(i) == ".") { last = i; }
    i = i + 1;
  }
  if (last < 0) { return ""; }
  return key.substring(0, last);
}

function leafKey(key: string): string {
  let last: int = -1;
  let i: int = 0;
  while (i < key.length) {
    if (key.charAt(i) == ".") { last = i; }
    i = i + 1;
  }
  if (last < 0) { return key; }
  return key.substring(last + 1, key.length);
}

export function stringify(entries: string[]): string {
  let out = "";
  let section = "";
  for (const entry of entries) {
    let key = entryKey(entry);
    let value = entryValue(entry);
    let parent = parentKey(key);
    let leaf = leafKey(key);
    if (parent != section) {
      if (out != "") { out = out + "\n"; }
      if (parent != "") { out = out + "[" + parent + "]\n"; }
      section = parent;
    }
    out = out + leaf + " = " + valueLiteral(value) + "\n";
  }
  return out;
}

test("top-level values", () => {
  let doc = "title = \"Lumen\"\ncount = 42\nenabled = true\n";
  expect(getString(doc, "title", "") == "Lumen");
  expect(getInt(doc, "count", 0) == 42);
  expect(getBool(doc, "enabled", false));
});

test("sections and dotted keys", () => {
  let doc = "[package]\nname = \"demo\"\nversion.major = 1\n[database.primary]\nport = 5432\n";
  expect(getString(doc, "package.name", "") == "demo");
  expect(getInt(doc, "package.version.major", 0) == 1);
  expect(getInt(doc, "database.primary.port", 0) == 5432);
});

test("comments and quotes", () => {
  let doc = "# comment\nname = \"hash # inside\" # outside\nliteral = 'a # b'\n";
  expect(getString(doc, "name", "") == "hash # inside");
  expect(getString(doc, "literal", "") == "a # b");
});

test("arrays", () => {
  let doc = "langs = [\"lumen\", \"zig\", \"ts\"]\nports = [8000, 9000]\n";
  let langs = getArray(doc, "langs");
  let ports = getArray(doc, "ports");
  expect(langs.length == 3);
  expect(langs[0] == "lumen");
  expect(langs[2] == "ts");
  expect(ports[1] == "9000");
});

test("stringify normalized entries", () => {
  let entries: string[] = ["title=Lumen", "package.name=demo", "package.enabled=true", "package.count=3", "database.ports=[8000, 9000]"];
  let doc = stringify(entries);
  expect(doc.includes("title = \"Lumen\""));
  expect(doc.includes("[package]"));
  expect(doc.includes("name = \"demo\""));
  expect(doc.includes("enabled = true"));
  expect(doc.includes("count = 3"));
  expect(doc.includes("[database]"));
  expect(doc.includes("ports = [8000, 9000]"));
  expect(getString(doc, "package.name", "") == "demo");
  expect(getBool(doc, "package.enabled", false));
  expect(getInt(doc, "package.count", 0) == 3);
});

test("parse stringify round trip for supported entries", () => {
  let src = "title = \"Lumen\"\n[package]\nname = \"demo\"\nenabled = true\ncount = 3\n";
  let doc = stringify(parse(src));
  expect(getString(doc, "title", "") == "Lumen");
  expect(getString(doc, "package.name", "") == "demo");
  expect(getBool(doc, "package.enabled", false));
  expect(getInt(doc, "package.count", 0) == 3);
});

test("keys and duplicate values", () => {
  let doc = "name = \"old\"\nname = \"new\"\n[tool]\nenabled = false\n";
  let ks = keys(doc);
  expect(ks.length == 3);
  expect(ks[0] == "name");
  expect(ks[2] == "tool.enabled");
  expect(has(doc, "tool.enabled"));
  expect(getString(doc, "name", "") == "new");
  expect(!getBool(doc, "tool.enabled", true));
});

test("invalid lines are ignored", () => {
  let doc = "no equals\nbad key = 1\nok = 2\n[bad section\nnext = 3\n";
  expect(getInt(doc, "ok", 0) == 2);
  expect(getInt(doc, "next", 0) == 3);
  expect(!has(doc, "bad key"));
});

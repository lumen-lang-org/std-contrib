// semver -- Semantic Versioning parser, comparator, incrementer, and range
// evaluator. Pure Lumen: no FFI, no JavaScript runtime, no Node dependency.
//
// Run: lumen test packages/semver/semver.ts

interface Version {
  major: int;
  minor: int;
  patch: int;
  prerelease: string[];
  build: string[];
}

function fail(kind: string, message: string, at: int): void {
  throw Error(kind + ": " + message);
}

function isDigit(c: string): bool {
  let x = c.charCodeAt(0);
  return x >= "0".charCodeAt(0) && x <= "9".charCodeAt(0);
}

function isAlpha(c: string): bool {
  let x = c.charCodeAt(0);
  return (x >= "a".charCodeAt(0) && x <= "z".charCodeAt(0)) || (x >= "A".charCodeAt(0) && x <= "Z".charCodeAt(0));
}

function isIdentChar(c: string): bool {
  return isDigit(c) || isAlpha(c) || c == "-";
}

function toInt(s: string): int {
  if (s == "") { fail("UnexpectedEnd", "expected number", 0); }
  let n: int = 0;
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (!isDigit(c)) { fail("InvalidCharacter", "expected digit", i); }
    n = n * 10 + (c.charCodeAt(0) - "0".charCodeAt(0));
    i = i + 1;
  }
  return n;
}

function digit(n: int): string {
  if (n == 0) { return "0"; }
  if (n == 1) { return "1"; }
  if (n == 2) { return "2"; }
  if (n == 3) { return "3"; }
  if (n == 4) { return "4"; }
  if (n == 5) { return "5"; }
  if (n == 6) { return "6"; }
  if (n == 7) { return "7"; }
  if (n == 8) { return "8"; }
  return "9";
}

function intString(n: int): string {
  if (n == 0) { return "0"; }
  let x = n;
  let div: int = 1;
  while (x / div >= 10) { div = div * 10; }
  let out = "";
  while (div > 0) {
    let d = x / div;
    out = out + digit(d);
    x = x - d * div;
    div = div / 10;
  }
  return out;
}

function readNumber(input: string, start: int): int {
  if (start >= input.length) { fail("UnexpectedEnd", "expected numeric identifier", start); }
  let i: int = start;
  while (i < input.length && isDigit(input.charAt(i))) { i = i + 1; }
  if (i == start) { fail("InvalidCharacter", "expected digit", start); }
  if (i - start > 1 && input.charAt(start) == "0") {
    fail("InvalidNumericIdentifier", "leading zero", start);
  }
  return i;
}

function readIdentifier(input: string, start: int, prerelease: bool): int {
  if (start >= input.length) { fail("UnexpectedEnd", "expected identifier", start); }
  let i: int = start;
  let numeric: bool = true;
  while (i < input.length && isIdentChar(input.charAt(i))) {
    if (!isDigit(input.charAt(i))) { numeric = false; }
    i = i + 1;
  }
  if (i == start) { fail("InvalidCharacter", "expected identifier", start); }
  if (prerelease && numeric && i - start > 1 && input.charAt(start) == "0") {
    fail("InvalidPrerelease", "numeric identifier has leading zero", start);
  }
  return i;
}

function validateIdentifiers(input: string, start: int, end: int, prerelease: bool): void {
  let i: int = start;
  while (i < end) {
    let next = readIdentifier(input, i, prerelease);
    i = next;
    if (i < end) {
      if (input.charAt(i) != ".") { fail("InvalidCharacter", "expected dot", i); }
      i = i + 1;
      if (i >= end) { fail("UnexpectedEnd", "empty identifier", i); }
    }
  }
}

function emptyParts(): string[] {
  let a: string[] = [];
  return a;
}

export function parse(input: string): Version {
  let n: int = input.length;
  let i: int = 0;
  let majorEnd: int = readNumber(input, i);
  let major: int = toInt(input.substring(i, majorEnd));
  i = majorEnd;
  if (i >= n || input.charAt(i) != ".") { fail("InvalidVersion", "expected dot after major", i); }
  i = i + 1;

  let minorEnd: int = readNumber(input, i);
  let minor: int = toInt(input.substring(i, minorEnd));
  i = minorEnd;
  if (i >= n || input.charAt(i) != ".") { fail("InvalidVersion", "expected dot after minor", i); }
  i = i + 1;

  let patchEnd: int = readNumber(input, i);
  let patch: int = toInt(input.substring(i, patchEnd));
  i = patchEnd;

  let pre: string[] = emptyParts();
  let build: string[] = emptyParts();
  if (i < n && input.charAt(i) == "-") {
    i = i + 1;
    let start: int = i;
    while (i < n && input.charAt(i) != "+") {
      if (!isIdentChar(input.charAt(i)) && input.charAt(i) != ".") {
        fail("InvalidCharacter", "invalid prerelease character", i);
      }
      i = i + 1;
    }
    if (i == start) { fail("InvalidPrerelease", "empty prerelease", start); }
    validateIdentifiers(input, start, i, true);
    pre = input.substring(start, i).split(".");
  }

  if (i < n && input.charAt(i) == "+") {
    i = i + 1;
    let start: int = i;
    while (i < n) {
      if (!isIdentChar(input.charAt(i)) && input.charAt(i) != ".") {
        fail("InvalidCharacter", "invalid build character", i);
      }
      i = i + 1;
    }
    if (i == start) { fail("UnexpectedEnd", "empty build metadata", start); }
    validateIdentifiers(input, start, i, false);
    build = input.substring(start, i).split(".");
  }

  if (i != n) { fail("InvalidCharacter", "trailing input", i); }
  return { major: major, minor: minor, patch: patch, prerelease: pre, build: build };
}

function readNumberOk(input: string, start: int): int {
  if (start >= input.length || !isDigit(input.charAt(start))) { return -1; }
  let i: int = start;
  while (i < input.length && isDigit(input.charAt(i))) { i = i + 1; }
  if (i - start > 1 && input.charAt(start) == "0") { return -1; }
  return i;
}

function identifiersOk(input: string, start: int, end: int, prerelease: bool): bool {
  let i: int = start;
  if (i >= end) { return false; }
  while (i < end) {
    let identStart: int = i;
    let numeric: bool = true;
    while (i < end && isIdentChar(input.charAt(i))) {
      if (!isDigit(input.charAt(i))) { numeric = false; }
      i = i + 1;
    }
    if (i == identStart) { return false; }
    if (prerelease && numeric && i - identStart > 1 && input.charAt(identStart) == "0") { return false; }
    if (i < end) {
      if (input.charAt(i) != ".") { return false; }
      i = i + 1;
      if (i >= end) { return false; }
    }
  }
  return true;
}

export function valid(input: string): bool {
  let n: int = input.length;
  let i: int = 0;
  i = readNumberOk(input, i);
  if (i < 0 || i >= n || input.charAt(i) != ".") { return false; }
  i = i + 1;
  i = readNumberOk(input, i);
  if (i < 0 || i >= n || input.charAt(i) != ".") { return false; }
  i = i + 1;
  i = readNumberOk(input, i);
  if (i < 0) { return false; }
  if (i < n && input.charAt(i) == "-") {
    i = i + 1;
    let start: int = i;
    while (i < n && input.charAt(i) != "+") {
      if (!isIdentChar(input.charAt(i)) && input.charAt(i) != ".") { return false; }
      i = i + 1;
    }
    if (!identifiersOk(input, start, i, true)) { return false; }
  }
  if (i < n && input.charAt(i) == "+") {
    i = i + 1;
    let start: int = i;
    while (i < n) {
      if (!isIdentChar(input.charAt(i)) && input.charAt(i) != ".") { return false; }
      i = i + 1;
    }
    if (!identifiersOk(input, start, i, false)) { return false; }
  }
  return i == n;
}

export function clean(input: string): string {
  let s = input.trim();
  if (s.startsWith("v") || s.startsWith("V")) { s = s.substring(1, s.length); }
  let v = parse(s);
  return format(v);
}

export function format(v: Version): string {
  let out = intString(v.major) + "." + intString(v.minor) + "." + intString(v.patch);
  if (v.prerelease.length > 0) { out = out + "-" + v.prerelease.join("."); }
  if (v.build.length > 0) { out = out + "+" + v.build.join("."); }
  return out;
}

function isNumericIdentifier(s: string): bool {
  if (s == "") { return false; }
  let i: int = 0;
  while (i < s.length) {
    if (!isDigit(s.charAt(i))) { return false; }
    i = i + 1;
  }
  return true;
}

function cmpInt(a: int, b: int): int {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}

function cmpString(a: string, b: string): int {
  let i: int = 0;
  while (i < a.length && i < b.length) {
    let ac = a.charCodeAt(i);
    let bc = b.charCodeAt(i);
    if (ac < bc) { return -1; }
    if (ac > bc) { return 1; }
    i = i + 1;
  }
  if (a.length < b.length) { return -1; }
  if (a.length > b.length) { return 1; }
  return 0;
}

export function compareVersions(a: Version, b: Version): int {
  let c = cmpInt(a.major, b.major);
  if (c != 0) { return c; }
  c = cmpInt(a.minor, b.minor);
  if (c != 0) { return c; }
  c = cmpInt(a.patch, b.patch);
  if (c != 0) { return c; }

  if (a.prerelease.length == 0 && b.prerelease.length == 0) { return 0; }
  if (a.prerelease.length == 0) { return 1; }
  if (b.prerelease.length == 0) { return -1; }

  let i: int = 0;
  while (i < a.prerelease.length && i < b.prerelease.length) {
    let av = a.prerelease[i];
    let bv = b.prerelease[i];
    let an = isNumericIdentifier(av);
    let bn = isNumericIdentifier(bv);
    if (an && bn) {
      c = cmpInt(toInt(av), toInt(bv));
    } else if (an) {
      c = -1;
    } else if (bn) {
      c = 1;
    } else {
      c = cmpString(av, bv);
    }
    if (c != 0) { return c; }
    i = i + 1;
  }
  return cmpInt(a.prerelease.length, b.prerelease.length);
}

export function compare(a: string, b: string): int {
  return compareVersions(parse(a), parse(b));
}

export function eq(a: string, b: string): bool { return compare(a, b) == 0; }
export function neq(a: string, b: string): bool { return compare(a, b) != 0; }
export function gt(a: string, b: string): bool { return compare(a, b) > 0; }
export function gte(a: string, b: string): bool { return compare(a, b) >= 0; }
export function lt(a: string, b: string): bool { return compare(a, b) < 0; }
export function lte(a: string, b: string): bool { return compare(a, b) <= 0; }

function nthSorted(list: string[], index: int, desc: bool): string {
  let best = list[0];
  let bestRank: int = 1000000000;
  for (const candidate of list) {
    let rank: int = 0;
    for (const other of list) {
      let c = compare(other, candidate);
      if (desc) { c = 0 - c; }
      if (c < 0 || (c == 0 && cmpString(other, candidate) < 0)) { rank = rank + 1; }
    }
    if (rank >= index && rank < bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

export function sort(list: string[]): string[] {
  if (list.length == 0) { return list; }
  let out = "";
  let i: int = 0;
  while (i < list.length) {
    if (i > 0) { out = out + "\n"; }
    out = out + nthSorted(list, i, false);
    i = i + 1;
  }
  return out.split("\n");
}

export function rsort(list: string[]): string[] {
  if (list.length == 0) { return list; }
  let out = "";
  let i: int = 0;
  while (i < list.length) {
    if (i > 0) { out = out + "\n"; }
    out = out + nthSorted(list, i, true);
    i = i + 1;
  }
  return out.split("\n");
}

export function inc(version: string, release: string): string {
  let v = parse(version);
  if (release == "patch") {
    return intString(v.major) + "." + intString(v.minor) + "." + intString(v.patch + 1);
  }
  if (release == "minor") {
    return intString(v.major) + "." + intString(v.minor + 1) + ".0";
  }
  if (release == "major") {
    return intString(v.major + 1) + ".0.0";
  }
  if (release == "prerelease") {
    if (v.prerelease.length == 0) {
      return intString(v.major) + "." + intString(v.minor) + "." + intString(v.patch + 1) + "-0";
    }
    let last = v.prerelease[v.prerelease.length - 1];
    if (isNumericIdentifier(last)) {
      let out = intString(v.major) + "." + intString(v.minor) + "." + intString(v.patch) + "-";
      let i: int = 0;
      while (i < v.prerelease.length) {
        if (i > 0) { out = out + "."; }
        if (i == v.prerelease.length - 1) { out = out + intString(toInt(last) + 1); }
        else { out = out + v.prerelease[i]; }
        i = i + 1;
      }
      return out;
    }
    return intString(v.major) + "." + intString(v.minor) + "." + intString(v.patch) + "-" + v.prerelease.join(".") + ".0";
  }
  fail("InvalidRelease", "unknown release type", 0);
  return "";
}

function partialMajor(token: string): int {
  let p = token.split(".");
  if (p.length == 0 || p[0] == "" || p[0] == "*" || p[0] == "x" || p[0] == "X") { return -1; }
  return toInt(p[0]);
}

function partialMinor(token: string): int {
  let p = token.split(".");
  if (p.length < 2 || p[1] == "" || p[1] == "*" || p[1] == "x" || p[1] == "X") { return -1; }
  return toInt(p[1]);
}

function partialPatch(token: string): int {
  let p = token.split(".");
  if (p.length < 3 || p[2] == "" || p[2] == "*" || p[2] == "x" || p[2] == "X") { return -1; }
  return toInt(p[2]);
}

function baseVersion(token: string): string {
  let maj = partialMajor(token);
  let min = partialMinor(token);
  let pat = partialPatch(token);
  if (maj < 0) { return "0.0.0"; }
  if (min < 0) { min = 0; }
  if (pat < 0) { pat = 0; }
  return intString(maj) + "." + intString(min) + "." + intString(pat);
}

function upperForX(token: string): string {
  let maj = partialMajor(token);
  let min = partialMinor(token);
  let pat = partialPatch(token);
  if (maj < 0) { return ""; }
  if (min < 0) { return intString(maj + 1) + ".0.0"; }
  if (pat < 0) { return intString(maj) + "." + intString(min + 1) + ".0"; }
  return "";
}

function hasWildcard(token: string): bool {
  return token == "*" || token == "x" || token == "X" || token.includes(".*") || token.includes(".x") || token.includes(".X");
}

function satisfiesComparator(version: string, token: string): bool {
  if (token == "" || token == "*" || token == "x" || token == "X") { return true; }

  if (token.startsWith("^")) {
    let body = token.substring(1, token.length);
    let base = baseVersion(body);
    let maj = partialMajor(body);
    let min = partialMinor(body);
    let pat = partialPatch(body);
    if (maj < 0) { return true; }
    if (min < 0) { min = 0; }
    if (pat < 0) { pat = 0; }
    let upper = "";
    if (maj > 0) { upper = intString(maj + 1) + ".0.0"; }
    else if (min > 0) { upper = "0." + intString(min + 1) + ".0"; }
    else { upper = "0.0." + intString(pat + 1); }
    return compare(version, base) >= 0 && compare(version, upper) < 0;
  }

  if (token.startsWith("~")) {
    let body = token.substring(1, token.length);
    let base = baseVersion(body);
    let maj = partialMajor(body);
    let min = partialMinor(body);
    if (maj < 0) { return true; }
    if (min < 0) { return compare(version, base) >= 0 && compare(version, intString(maj + 1) + ".0.0") < 0; }
    return compare(version, base) >= 0 && compare(version, intString(maj) + "." + intString(min + 1) + ".0") < 0;
  }

  let op = "=";
  let body = token;
  if (token.startsWith(">=") || token.startsWith("<=")) {
    op = token.substring(0, 2);
    body = token.substring(2, token.length);
  } else if (token.startsWith(">") || token.startsWith("<") || token.startsWith("=")) {
    op = token.substring(0, 1);
    body = token.substring(1, token.length);
  }
  body = body.trim();

  if (hasWildcard(body) || body.split(".").length < 3) {
    let upper = upperForX(body);
    let base = baseVersion(body);
    if (upper == "") {
      if (op == "=") { return compare(version, base) == 0; }
    }
    if (op == ">" || op == ">=") { return compare(version, base) >= 0; }
    if (op == "<" || op == "<=") { return compare(version, upper) < 0; }
    return compare(version, base) >= 0 && compare(version, upper) < 0;
  }

  let c = compare(version, body);
  if (op == ">") { return c > 0; }
  if (op == ">=") { return c >= 0; }
  if (op == "<") { return c < 0; }
  if (op == "<=") { return c <= 0; }
  return c == 0;
}

function satisfiesSet(version: string, set: string): bool {
  let parts = set.trim().split(" ");
  let i: int = 0;
  while (i < parts.length) {
    let part = parts[i].trim();
    if (part != "" && !satisfiesComparator(version, part)) { return false; }
    i = i + 1;
  }
  return true;
}

export function satisfies(version: string, range: string): bool {
  parse(version);
  let sets = range.split("||");
  let i: int = 0;
  while (i < sets.length) {
    if (sets[i].trim() == "") { fail("InvalidRange", "empty range set", i); }
    if (satisfiesSet(version, sets[i])) { return true; }
    i = i + 1;
  }
  return false;
}

test("parse and format versions", () => {
  let v = parse("1.2.3-alpha.1+build.5");
  expect(v.major == 1);
  expect(v.minor == 2);
  expect(v.patch == 3);
  expect(v.prerelease[0] == "alpha");
  expect(v.prerelease[1] == "1");
  expect(v.build[0] == "build");
  expect(format(v) == "1.2.3-alpha.1+build.5");
  expect(clean(" v1.2.3 ") == "1.2.3");
});

test("reject invalid versions", () => {
  expect(!valid(""));
  expect(!valid("1"));
  expect(!valid("1.2"));
  expect(!valid("1.2.3.4"));
  expect(!valid("01.2.3"));
  expect(!valid("1.02.3"));
  expect(!valid("1.2.03"));
  expect(!valid("1.2.3-"));
  expect(!valid("1.2.3-alpha..1"));
  expect(!valid("1.2.3-01"));
  expect(!valid("1.2.3+"));
  expect(!valid("1.2.3+build..1"));
  expect(!valid("1.2.3@"));
});

test("compare precedence", () => {
  expect(lt("1.0.0-alpha", "1.0.0-alpha.1"));
  expect(lt("1.0.0-alpha.1", "1.0.0-alpha.beta"));
  expect(lt("1.0.0-alpha.beta", "1.0.0-beta"));
  expect(lt("1.0.0-beta", "1.0.0-beta.2"));
  expect(lt("1.0.0-beta.2", "1.0.0-beta.11"));
  expect(lt("1.0.0-beta.11", "1.0.0-rc.1"));
  expect(lt("1.0.0-rc.1", "1.0.0"));
  expect(eq("1.0.0+build.1", "1.0.0+build.2"));
  expect(gt("2.0.0", "1.0.0"));
  expect(gte("1.0.0", "1.0.0"));
  expect(lte("1.0.0", "1.0.0"));
  expect(neq("1.0.1", "1.0.0"));
});

test("sort and reverse sort", () => {
  let list: string[] = ["1.0.0", "1.0.0-alpha", "2.0.0", "1.0.0-beta"];
  let asc = sort(list);
  expect(asc[0] == "1.0.0-alpha");
  expect(asc[1] == "1.0.0-beta");
  expect(asc[2] == "1.0.0");
  expect(asc[3] == "2.0.0");
  let desc = rsort(list);
  expect(desc[0] == "2.0.0");
  expect(desc[3] == "1.0.0-alpha");
});

test("increment versions", () => {
  expect(inc("1.2.3", "patch") == "1.2.4");
  expect(inc("1.2.3", "minor") == "1.3.0");
  expect(inc("1.2.3", "major") == "2.0.0");
  expect(inc("1.2.3", "prerelease") == "1.2.4-0");
  expect(inc("1.2.3-alpha.1", "prerelease") == "1.2.3-alpha.2");
});

test("range satisfaction", () => {
  expect(satisfies("1.5.0", "^1.2.0"));
  expect(!satisfies("2.0.0", "^1.2.0"));
  expect(satisfies("1.4.5", "~1.4.0"));
  expect(!satisfies("1.5.0", "~1.4.0"));
  expect(satisfies("1.5.0", ">=1.0.0 <2.0.0"));
  expect(!satisfies("2.0.0", ">=1.0.0 <2.0.0"));
  expect(satisfies("1.9.0", "1.x"));
  expect(!satisfies("2.0.0", "1.x"));
  expect(satisfies("1.5.9", "1.5.x"));
  expect(satisfies("2.1.0", "^1.2 || ^2.0"));
  expect(satisfies("3.0.0", "*"));
});

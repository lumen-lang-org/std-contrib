export function jsonBlank(ch: string): bool {
  return ch == " " || ch == "\n" || ch == "\t" || ch == "\r";
}

export function jsonFind(document: string, key: string): int {
  let i: int = 0;
  while (i < document.length) {
    if (document.charAt(i) != "\"") {
      i = i + 1;
      continue;
    }
    let j = i + 1;
    let name = "";
    while (j < document.length) {
      let ch = document.charAt(j);
      if (ch == "\\") {
        name = name + document.slice(j, j + 2);
        j = j + 2;
        continue;
      }
      if (ch == "\"") {
        break;
      }
      name = name + ch;
      j = j + 1;
    }
    if (j >= document.length) {
      return -1;
    }
    let after = j + 1;
    while (after < document.length && jsonBlank(document.charAt(after))) {
      after = after + 1;
    }
    if (name == key && after < document.length && document.charAt(after) == ":") {
      return after + 1;
    }
    i = j + 1;
  }
  return -1;
}

export function jsonValueAt(document: string, from: int): string {
  let i = from;
  while (i < document.length && jsonBlank(document.charAt(i))) {
    i = i + 1;
  }
  if (i >= document.length) {
    return "";
  }
  let start = i;
  let first = document.charAt(i);

  if (first == "\"") {
    i = i + 1;
    while (i < document.length) {
      let ch = document.charAt(i);
      if (ch == "\\") {
        i = i + 2;
        continue;
      }
      if (ch == "\"") {
        return document.slice(start, i + 1);
      }
      i = i + 1;
    }
    return "";
  }

  if (first == "{" || first == "[") {
    let depth: int = 0;
    let inString: bool = false;
    while (i < document.length) {
      let ch = document.charAt(i);
      if (inString) {
        if (ch == "\\") {
          i = i + 2;
          continue;
        }
        if (ch == "\"") {
          inString = false;
        }
        i = i + 1;
        continue;
      }
      if (ch == "\"") {
        inString = true;
        i = i + 1;
        continue;
      }
      if (ch == "{" || ch == "[") {
        depth = depth + 1;
      }
      if (ch == "}" || ch == "]") {
        depth = depth - 1;
        if (depth == 0) {
          return document.slice(start, i + 1);
        }
      }
      i = i + 1;
    }
    return "";
  }

  while (i < document.length) {
    let ch = document.charAt(i);
    if (ch == "," || ch == "}" || ch == "]" || jsonBlank(ch)) {
      return document.slice(start, i);
    }
    i = i + 1;
  }
  return document.slice(start, document.length);
}

export function jsonRaw(document: string, key: string): string {
  let at = jsonFind(document, key);
  if (at < 0) {
    return "";
  }
  return jsonValueAt(document, at);
}

export function jsonText(document: string, key: string): string {
  let raw = jsonRaw(document, key);
  if (raw.length < 2 || !raw.startsWith("\"")) {
    return "";
  }
  return jsonUnescape(raw.slice(1, raw.length - 1));
}

export function jsonFlag(document: string, key: string, fallback: bool): bool {
  let raw = jsonRaw(document, key);
  if (raw == "") {
    return fallback;
  }
  return raw == "true" || raw == "\"true\"";
}

export type JsonText = {
  found: bool,
  text: string,
};

export function jsonStringMember(document: string, key: string): JsonText {
  let absent: JsonText = { found: false, text: "" };
  let rest = document;
  while (true) {
    let at = jsonFind(rest, key);
    if (at < 0) {
      return absent;
    }
    let raw = jsonValueAt(rest, at);
    if (raw.length >= 2 && raw.startsWith("\"")) {
      let hit: JsonText = { found: true, text: jsonUnescape(raw.slice(1, raw.length - 1)) };
      return hit;
    }
    let step = raw.length;
    if (step < 1) {
      step = 1;
    }
    if (at + step >= rest.length) {
      return absent;
    }
    rest = rest.slice(at + step, rest.length);
  }
  return absent;
}

export function jsonList(array: string): string[] {
  let out: string[] = [];
  let i: int = 0;
  while (i < array.length && jsonBlank(array.charAt(i))) {
    i = i + 1;
  }
  if (i >= array.length || array.charAt(i) != "[") {
    return out;
  }
  i = i + 1;
  while (i < array.length) {
    while (i < array.length) {
      let ch = array.charAt(i);
      if (!jsonBlank(ch) && ch != ",") {
        break;
      }
      i = i + 1;
    }
    if (i >= array.length || array.charAt(i) == "]") {
      return out;
    }
    let item = jsonValueAt(array, i);
    if (item == "") {
      return out;
    }
    out.push(item);
    i = i + item.length;
  }
  return out;
}

function hexDigit(ch: string): int {
  let c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) {
    return c - 48;
  }
  if (c >= 97 && c <= 102) {
    return c - 87;
  }
  if (c >= 65 && c <= 70) {
    return c - 55;
  }
  return -1;
}

function hex4(literal: string, from: int): int {
  if (from + 4 > literal.length) {
    return -1;
  }
  let value: int = 0;
  let i: int = 0;
  while (i < 4) {
    let d = hexDigit(literal.charAt(from + i));
    if (d < 0) {
      return -1;
    }
    value = value * 16 + d;
    i = i + 1;
  }
  return value;
}

export function jsonUnescape(body: string): string {
  let out = "";
  let i: int = 0;
  while (i < body.length) {
    let ch = body.charAt(i);
    if (ch != "\\" || i + 1 >= body.length) {
      out = out + ch;
      i = i + 1;
      continue;
    }
    let next = body.charAt(i + 1);
    if (next == "n") {
      out = out + "\n";
      i = i + 2;
      continue;
    }
    if (next == "t") {
      out = out + "\t";
      i = i + 2;
      continue;
    }
    if (next == "r") {
      out = out + "\r";
      i = i + 2;
      continue;
    }
    if (next == "b" || next == "f") {
      i = i + 2;
      continue;
    }
    if (next == "u") {
      let code = hex4(body, i + 2);
      if (code < 0) {
        out = out + next;
        i = i + 2;
        continue;
      }
      i = i + 6;
      if (code >= 55296 && code <= 56319 && i + 1 < body.length) {
        if (body.charAt(i) == "\\" && body.charAt(i + 1) == "u") {
          let low = hex4(body, i + 2);
          if (low >= 56320 && low <= 57343) {
            code = 65536 + (code - 55296) * 1024 + (low - 56320);
            i = i + 6;
          }
        }
      }
      out = out + String.fromCodePoint(code);
      continue;
    }
    out = out + next;
    i = i + 2;
  }
  return out;
}

export function jsonComplete(text: string): bool {
  let i: int = 0;
  while (i < text.length && jsonBlank(text.charAt(i))) {
    i = i + 1;
  }
  if (i >= text.length || text.charAt(i) != "{") {
    return false;
  }

  let open = "";
  let inString = false;
  let escaped = false;
  let end: int = -1;
  while (i < text.length) {
    let ch = text.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      }
      else if (ch == "\\") {
        escaped = true;
      }
      else if (ch == "\"") {
        inString = false;
      }
      else if (ch == "\n" || ch == "\r" || ch == "\t") {
        return false;
      }
      i = i + 1;
      continue;
    }
    if (ch == "\"") {
      inString = true;
    }
    else if (ch == "{") {
      open = open + "}";
    }
    else if (ch == "[") {
      open = open + "]";
    }
    else if (ch == "}" || ch == "]") {
      if (open.length == 0 || open.charAt(open.length - 1) != ch) {
        return false;
      }
      open = open.slice(0, open.length - 1);
      if (open.length == 0) {
        end = i;
        break;
      }
    }
    i = i + 1;
  }
  if (end < 0) {
    return false;
  }

  let after = end + 1;
  while (after < text.length) {
    if (!jsonBlank(text.charAt(after))) {
      return false;
    }
    after = after + 1;
  }
  return true;
}

export function excerptOf(body: string, at: int): string {
  if (body.length <= at) {
    return body;
  }
  let cut = at;
  while (cut > 0 && (body.charCodeAt(cut) & 0xC0) == 0x80) {
    cut = cut - 1;
  }
  return body.slice(0, cut);
}

export type View = {
  text: Map<string, string>,
  lists: Map<string, Map<string, string>[]>,
};

export function view(): View {
  return { text: new Map<string, string>(), lists: new Map<string, Map<string, string>[]>() };
}

export function escapeHtml(raw: string): string {
  let out = "";
  let i: int = 0;
  while (i < raw.length) {
    let c = raw.slice(i, i + 1);
    if (c == "&") { out = out + "&amp;"; }
    else if (c == "<") { out = out + "&lt;"; }
    else if (c == ">") { out = out + "&gt;"; }
    else if (c == "\"") { out = out + "&quot;"; }
    else if (c == "'") { out = out + "&#39;"; }
    else { out = out + c; }
    i = i + 1;
  }
  return out;
}

type Tag = { at: int, end: int, kind: string, arg: string };

function tagAt(src: string, from: int): Tag {
  let open = src.indexOf("<%", from);
  if (open < 0) { return { at: -1, end: -1, kind: "", arg: "" }; }
  let close = src.indexOf("%>", open);
  if (close < 0) { return { at: -1, end: -1, kind: "", arg: "" }; }
  let inner = src.slice(open + 2, close).trim();
  let kind = "code";
  if (inner.startsWith("=")) { kind = "escaped"; inner = inner.slice(1).trim(); }
  else if (inner.startsWith("-")) { kind = "raw"; inner = inner.slice(1).trim(); }
  else if (inner.startsWith("#")) { kind = "comment"; inner = ""; }
  return { at: open, end: close + 2, kind: kind, arg: inner };
}

function keyword(arg: string): string {
  let space = arg.indexOf(" ");
  if (space < 0) { return arg; }
  return arg.slice(0, space);
}

function argument(arg: string): string {
  let space = arg.indexOf(" ");
  if (space < 0) { return ""; }
  return arg.slice(space + 1).trim();
}

function matchingEnd(src: string, from: int): int {
  let depth: int = 1;
  let at = from;
  while (at < src.length) {
    let t = tagAt(src, at);
    if (t.at < 0) { return -1; }
    if (t.kind == "code") {
      let word = keyword(t.arg);
      if (word == "if" || word == "each") { depth = depth + 1; }
      else if (word == "end") {
        depth = depth - 1;
        if (depth == 0) { return t.at; }
      }
    }
    at = t.end;
  }
  return -1;
}

function elseAt(src: string, from: int, to: int): int {
  let depth: int = 0;
  let at = from;
  while (at < to) {
    let t = tagAt(src, at);
    if (t.at < 0 || t.at >= to) { return -1; }
    if (t.kind == "code") {
      let word = keyword(t.arg);
      if (word == "if" || word == "each") { depth = depth + 1; }
      else if (word == "end") { depth = depth - 1; }
      else if (word == "else" && depth == 0) { return t.at; }
    }
    at = t.end;
  }
  return -1;
}

function valueOf(name: string, v: View, row: Map<string, string>, hasRow: bool): string {
  if (name.startsWith(".")) {
    if (!hasRow) { return ""; }
    return row.get(name.slice(1)) ?? "";
  }
  return v.text.get(name) ?? "";
}

function renderRange(src: string, from: int, to: int, v: View, row: Map<string, string>, hasRow: bool): string {
  let out = "";
  let at = from;
  while (at < to) {
    let t = tagAt(src, at);
    if (t.at < 0 || t.at >= to) {
      out = out + src.slice(at, to);
      return out;
    }
    out = out + src.slice(at, t.at);

    if (t.kind == "escaped") {
      out = out + escapeHtml(valueOf(t.arg, v, row, hasRow));
      at = t.end;
    } else if (t.kind == "raw") {
      out = out + valueOf(t.arg, v, row, hasRow);
      at = t.end;
    } else if (t.kind == "comment") {
      at = t.end;
    } else {
      let word = keyword(t.arg);
      if (word == "if") {
        let close = matchingEnd(src, t.end);
        if (close < 0) { return out + src.slice(t.end, to); }
        let split = elseAt(src, t.end, close);
        let truthy = valueOf(argument(t.arg), v, row, hasRow) != "";
        if (split < 0) {
          if (truthy) { out = out + renderRange(src, t.end, close, v, row, hasRow); }
        } else {
          let elseTag = tagAt(src, split);
          if (truthy) { out = out + renderRange(src, t.end, split, v, row, hasRow); }
          else { out = out + renderRange(src, elseTag.end, close, v, row, hasRow); }
        }
        at = tagAt(src, close).end;
      } else if (word == "each") {
        let close = matchingEnd(src, t.end);
        if (close < 0) { return out + src.slice(t.end, to); }
        let rows = v.lists.get(argument(t.arg));
        if (rows != null) {
          let list: Map<string, string>[] = rows;
          let i: int = 0;
          while (i < list.length) {
            out = out + renderRange(src, t.end, close, v, list[i], true);
            i = i + 1;
          }
        }
        at = tagAt(src, close).end;
      } else {
        at = t.end;
      }
    }
  }
  return out;
}

export function render(src: string, v: View): string {
  return renderRange(src, 0, src.length, v, new Map<string, string>(), false);
}

export function checkTemplate(src: string): string {
  let depth: int = 0;
  let at: int = 0;
  while (at < src.length) {
    let t = tagAt(src, at);
    if (t.at < 0) {
      if (src.indexOf("<%", at) >= 0) { return "a tag is opened with <% and never closed with %>"; }
      break;
    }
    if (t.kind == "code") {
      let word = keyword(t.arg);
      if (word == "if" || word == "each") {
        if (argument(t.arg) == "") { return word + " needs a name: <% " + word + " something %>"; }
        depth = depth + 1;
      } else if (word == "end") {
        depth = depth - 1;
        if (depth < 0) { return "an <% end %> closes a block that was never opened"; }
      } else if (word != "else") {
        return "unknown tag <% " + word + " %>: expected if, else, each or end";
      }
    }
    at = t.end;
  }
  if (depth > 0) { return "a block is opened and never closed with <% end %>"; }
  return "";
}

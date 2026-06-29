// markdown -- a small Markdown -> HTML renderer, written entirely in Lumen.
//
// Pure Lumen: no FFI, no native library, nothing to install or link. Import it
// by URL with no install step. Supports a practical
// subset of CommonMark: ATX headings, paragraphs, **bold** / *italic* / `code`,
// [links](url), `-`/`*` lists, > blockquotes, ``` fenced code, and --- rules.
//
//   import { render } from "https://lumen-lang.org/package/std-contrib/markdown/markdown.ts";
//   console.log(render("# Hello\n\nSome **bold** text."));
// esc() fast-paths text with nothing to escape, and inline text is flushed in
// runs (one concat per token) instead of character by character.
function esc(s: string): string {
  let i: int = 0;
  let bad: int = -1;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "&" || c == "<" || c == ">" || c == "\"") { bad = i; i = s.length; } else { i = i + 1; }
  }
  if (bad < 0) { return s; }
  let out = s.substring(0, bad);
  i = bad;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "&") { out = out + "&amp;"; }
    else if (c == "<") { out = out + "&lt;"; }
    else if (c == ">") { out = out + "&gt;"; }
    else if (c == "\"") { out = out + "&quot;"; }
    else { out = out + c; }
    i = i + 1;
  }
  return out;
}
function inlineMd(s: string): string {
  let out = "";
  let i: int = 0;
  let n: int = s.length;
  let runStart: int = 0;
  while (i < n) {
    let c = s.charAt(i);
    let handled: bool = false;
    if (c == "`") {
      let j: int = i + 1;
      while (j < n && s.charAt(j) != "`") { j = j + 1; }
      if (j < n) {
        out = out + esc(s.substring(runStart, i)) + "<code>" + esc(s.substring(i + 1, j)) + "</code>";
        i = j + 1; runStart = i; handled = true;
      }
    } else if (c == "*" && i + 1 < n && s.charAt(i + 1) == "*") {
      let j: int = i + 2;
      let found: int = -1;
      while (j + 1 < n) { if (s.charAt(j) == "*" && s.charAt(j + 1) == "*") { found = j; j = n; } else { j = j + 1; } }
      if (found >= 0) {
        out = out + esc(s.substring(runStart, i)) + "<strong>" + inlineMd(s.substring(i + 2, found)) + "</strong>";
        i = found + 2; runStart = i; handled = true;
      }
    } else if (c == "*") {
      let j: int = i + 1;
      while (j < n && s.charAt(j) != "*") { j = j + 1; }
      if (j < n) {
        out = out + esc(s.substring(runStart, i)) + "<em>" + inlineMd(s.substring(i + 1, j)) + "</em>";
        i = j + 1; runStart = i; handled = true;
      }
    } else if (c == "[") {
      let close: int = i + 1;
      while (close < n && s.charAt(close) != "]") { close = close + 1; }
      if (close + 1 < n && s.charAt(close + 1) == "(") {
        let ue: int = close + 2;
        while (ue < n && s.charAt(ue) != ")") { ue = ue + 1; }
        if (ue < n) {
          out = out + esc(s.substring(runStart, i)) + "<a href=\"" + esc(s.substring(close + 2, ue)) + "\">" + inlineMd(s.substring(i + 1, close)) + "</a>";
          i = ue + 1; runStart = i; handled = true;
        }
      }
    }
    if (!handled) { i = i + 1; }
  }
  out = out + esc(s.substring(runStart, i));
  return out;
}
function htag(level: int): string {
  if (level == 1) { return "h1"; }
  if (level == 2) { return "h2"; }
  if (level == 3) { return "h3"; }
  if (level == 4) { return "h4"; }
  if (level == 5) { return "h5"; }
  return "h6";
}
function isBlockStart(t: string): bool {
  return t.startsWith("#") || t.startsWith("- ") || t.startsWith("* ") || t.startsWith("> ") || t.startsWith("```") || t == "---";
}
export function render(md: string): string {
  let lines = md.split("\n");
  let out = "";
  let i: int = 0;
  let n: int = lines.length;
  while (i < n) {
    let t = lines[i].trim();
    if (t == "") { i = i + 1; continue; }
    if (t.startsWith("```")) {
      i = i + 1;
      let code = "";
      while (i < n && lines[i].trim() != "```") { code = code + esc(lines[i]) + "\n"; i = i + 1; }
      if (i < n) { i = i + 1; }
      out = out + "<pre><code>" + code + "</code></pre>\n";
      continue;
    }
    let h: int = 0;
    while (h < 6 && h < t.length && t.charAt(h) == "#") { h = h + 1; }
    if (h > 0 && h < t.length && t.charAt(h) == " ") {
      let tag = htag(h);
      out = out + "<" + tag + ">" + inlineMd(t.substring(h + 1).trim()) + "</" + tag + ">\n";
      i = i + 1; continue;
    }
    if (t == "---" || t == "***") { out = out + "<hr>\n"; i = i + 1; continue; }
    if (t.startsWith("> ") || t == ">") {
      let bq = "";
      while (i < n && (lines[i].trim().startsWith("> ") || lines[i].trim() == ">")) {
        let l = lines[i].trim();
        if (bq != "") { bq = bq + " "; }
        if (l.length > 1) { bq = bq + l.substring(1).trim(); }
        i = i + 1;
      }
      out = out + "<blockquote><p>" + inlineMd(bq) + "</p></blockquote>\n";
      continue;
    }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      out = out + "<ul>\n";
      while (i < n && (lines[i].trim().startsWith("- ") || lines[i].trim().startsWith("* "))) {
        out = out + "<li>" + inlineMd(lines[i].trim().substring(2).trim()) + "</li>\n";
        i = i + 1;
      }
      out = out + "</ul>\n";
      continue;
    }
    let para = "";
    while (i < n && lines[i].trim() != "" && !isBlockStart(lines[i].trim())) {
      if (para != "") { para = para + " "; }
      para = para + lines[i].trim(); i = i + 1;
    }
    out = out + "<p>" + inlineMd(para) + "</p>\n";
  }
  return out;
}

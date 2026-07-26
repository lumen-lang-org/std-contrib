// Prompt template helpers.

function replaceAllText(src: string, from: string, to: string): string {
  if (from == "") { return src; }
  let out = "";
  let i: int = 0;
  while (i < src.length) {
    if (i + from.length <= src.length && src.substring(i, i + from.length) == from) {
      out = out + to;
      i = i + from.length;
    } else {
      out = out + src.charAt(i);
      i = i + 1;
    }
  }
  return out;
}

function hasKey(keys: string[], key: string): bool {
  for (const item of keys) {
    if (item == key) { return true; }
  }
  return false;
}

function hasLine(lines: string, key: string): bool {
  if (lines == "") { return false; }
  let parts = lines.split("\n");
  for (const item of parts) {
    if (item == key) { return true; }
  }
  return false;
}

function findFrom(src: string, pattern: string, start: int): int {
  let i = start;
  while (i + pattern.length <= src.length) {
    if (src.substring(i, i + pattern.length) == pattern) { return i; }
    i = i + 1;
  }
  return -1;
}

// One template binding: the name beside its value.
//
// The earlier shape was two parallel arrays — keys and values paired up by
// position — which reads fine at one entry and stops reading at two: nothing
// keeps the lists aligned, and swapping two values compiles and renders the
// wrong prompt. A binding is one value, so the pair cannot drift apart.
export type TemplateVar = {
  name: string,
  value: string,
};

export function makeTemplateVar(name: string, value: string): TemplateVar {
  let v: TemplateVar = { name: name, value: value };
  return v;
}

// One entry of a chat prompt: a role and its template, together for the same
// reason a binding is.
export type ChatPromptPart = {
  role: string,
  template: string,
};

export function makeChatPromptPart(role: string, template: string): ChatPromptPart {
  let p: ChatPromptPart = { role: role, template: template };
  return p;
}

export function renderPromptTemplate(template: string, vars: TemplateVar[]): string {
  let out = template;
  let i: int = 0;
  while (i < vars.length) {
    out = replaceAllText(out, "{{" + vars[i].name + "}}", vars[i].value);
    i = i + 1;
  }
  return out;
}

export function missingTemplateVariables(template: string, keys: string[]): string[] {
  let out = "";
  let i: int = 0;
  while (i < template.length) {
    if (i + 2 <= template.length && template.substring(i, i + 2) == "{{") {
      let end = findFrom(template, "}}", i + 2);
      if (end < 0) { i = template.length; }
      else {
        let key = template.substring(i + 2, end);
        if (!hasKey(keys, key) && !hasLine(out, key)) {
          if (out != "") { out = out + "\n"; }
          out = out + key;
        }
        i = end + 2;
      }
    } else {
      i = i + 1;
    }
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

export function unusedTemplateVariables(template: string, keys: string[]): string[] {
  let out = "";
  for (const key of keys) {
    let marker = "{{" + key + "}}";
    if (template.indexOf(marker) < 0 && !hasLine(out, key)) {
      if (out != "") { out = out + "\n"; }
      out = out + key;
    }
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

export function renderChatPrompt(parts: ChatPromptPart[], vars: TemplateVar[]): string[] {
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    if (out != "") { out = out + "\n"; }
    out = out + parts[i].role + "\t" + renderPromptTemplate(parts[i].template, vars);
    i = i + 1;
  }
  if (out == "") {
    let empty: string[] = [];
    return empty;
  }
  return out.split("\n");
}

export function chatPromptRole(entry: string): string {
  let tab = entry.indexOf("\t");
  if (tab < 0) { return ""; }
  return entry.substring(0, tab);
}

export function chatPromptContent(entry: string): string {
  let tab = entry.indexOf("\t");
  if (tab < 0) { return entry; }
  return entry.substring(tab + 1, entry.length);
}

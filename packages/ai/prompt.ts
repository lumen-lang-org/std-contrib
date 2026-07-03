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

export function renderPromptTemplate(template: string, keys: string[], values: string[]): string {
  let out = template;
  let i: int = 0;
  while (i < keys.length && i < values.length) {
    out = replaceAllText(out, "{{" + keys[i] + "}}", values[i]);
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

export function renderChatPrompt(roles: string[], templates: string[], keys: string[], values: string[]): string[] {
  let out = "";
  let i: int = 0;
  while (i < roles.length && i < templates.length) {
    if (out != "") { out = out + "\n"; }
    out = out + roles[i] + "\t" + renderPromptTemplate(templates[i], keys, values);
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

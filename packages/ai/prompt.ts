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

export function renderPromptTemplate(template: string, keys: string[], values: string[]): string {
  let out = template;
  let i: int = 0;
  while (i < keys.length && i < values.length) {
    out = replaceAllText(out, "{{" + keys[i] + "}}", values[i]);
    i = i + 1;
  }
  return out;
}

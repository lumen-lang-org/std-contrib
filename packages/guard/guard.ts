export type FieldRule = { name: string, argsText: string[] };
export type FieldNote = { name: string, type: string, decorators: FieldRule[] };
export type Description = { protocol: int, name: string, fields: FieldNote[] };

export type Rule = { field: string, kind: string, limit: int, said: string };
export type Fault = { field: string, said: string };

export function checked(d: Description): Rule[] {
  let out: Rule[] = [];
  let i: int = 0;
  while (i < d.fields.length) {
    let f = d.fields[i];
    let j: int = 0;
    while (j < f.decorators.length) {
      let dec = f.decorators[j];
      let limit: int = 0;
      let said = "";
      if (dec.argsText.length == 1) {
        let only = dec.argsText[0];
        let n = parseInt(only, 10);
        if (n == null) { said = only; } else { limit = n; }
      } else if (dec.argsText.length > 1) {
        limit = parseInt(dec.argsText[0], 10) ?? 0;
        said = dec.argsText[1];
      }
      out.push({ field: f.name, kind: dec.name, limit: limit, said: said });
      j = j + 1;
    }
    i = i + 1;
  }
  return out;
}

function utf8Length(said: string): int {
  let n: int = 0;
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 128) { n = n + 1; }
    else if (c < 2048) { n = n + 2; }
    else { n = n + 3; }
    i = i + 1;
  }
  return n;
}

function member(body: string, key: string): string {
  let mark = "\"" + key + "\"";
  let at = body.indexOf(mark);
  if (at < 0) { return ""; }
  let colon = body.indexOf(":", at + mark.length);
  if (colon < 0) { return ""; }
  let i = colon + 1;
  while (i < body.length && (body.slice(i, i + 1) == " " || body.slice(i, i + 1) == "\n")) { i = i + 1; }
  if (i >= body.length) { return ""; }
  if (body.slice(i, i + 1) == "\"") {
    let out = "";
    let j = i + 1;
    while (j < body.length) {
      let c = body.slice(j, j + 1);
      if (c == "\\") { out = out + body.slice(j + 1, j + 2); j = j + 2; continue; }
      if (c == "\"") { return out; }
      out = out + c;
      j = j + 1;
    }
    return out;
  }
  let end = i;
  while (end < body.length) {
    let c = body.slice(end, end + 1);
    if (c == "," || c == "}" || c == "\n") { break; }
    end = end + 1;
  }
  return body.slice(i, end).trim();
}

function saidOr(r: Rule, fallback: string): string {
  if (r.said != "") { return r.said; }
  return fallback;
}

export function faults(rules: Rule[], body: string): Fault[] {
  let out: Fault[] = [];
  let i: int = 0;
  while (i < rules.length) {
    let r = rules[i];
    let value = member(body, r.field);
    if (r.kind == "required") {
      if (value.trim() == "") {
        out.push({ field: r.field, said: saidOr(r, "the field \"" + r.field + "\" is required") });
      }
    } else if (r.kind == "maxLength") {
      if (utf8Length(value) > r.limit) {
        out.push({ field: r.field, said: saidOr(r, "the field \"" + r.field + "\" is longer than " + `${r.limit}` + " bytes") });
      }
    } else if (r.kind == "minLength") {
      if (value != "" && utf8Length(value) < r.limit) {
        out.push({ field: r.field, said: saidOr(r, "the field \"" + r.field + "\" is shorter than " + `${r.limit}` + " bytes") });
      }
    } else if (r.kind == "max") {
      let n = parseInt(value, 10);
      if (n != null && n > r.limit) {
        out.push({ field: r.field, said: saidOr(r, "the field \"" + r.field + "\" is over " + `${r.limit}`) });
      }
    } else if (r.kind == "min") {
      let n = parseInt(value, 10);
      if (n != null && n < r.limit) {
        out.push({ field: r.field, said: saidOr(r, "the field \"" + r.field + "\" is under " + `${r.limit}`) });
      }
    }
    i = i + 1;
  }
  return out;
}

export function faultsJson(list: Fault[]): string {
  return JSON.stringify(list);
}

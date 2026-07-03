// csv -- CSV parser and stringifier, written entirely in Lumen.
//
// V1 uses a flat string[] representation plus row/column helpers so it works
// with the current language without nested dynamic records.
// Run: lumen test packages/csv/csv.ts

function parseDelimitedFields(src: string, delimiter: string, sep: string): string {
  let out = "";
  let field = "";
  let inQuotes: bool = false;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (inQuotes) {
      if (c == "\"") {
        if (i + 1 < src.length && src.charAt(i + 1) == "\"") {
          field = field + "\"";
          i = i + 2;
        } else {
          inQuotes = false;
          i = i + 1;
        }
      } else {
        field = field + c;
        i = i + 1;
      }
    } else if (c == "\"") {
      inQuotes = true;
      i = i + 1;
    } else if (c == delimiter) {
      out = out + field + sep;
      field = "";
      i = i + 1;
    } else if (c == "\n") {
      out = out + field + sep;
      field = "";
      i = i + 1;
    } else if (c == "\r") {
      out = out + field + sep;
      field = "";
      if (i + 1 < src.length && src.charAt(i + 1) == "\n") { i = i + 2; }
      else { i = i + 1; }
    } else {
      field = field + c;
      i = i + 1;
    }
  }
  if (src.length == 0) { return out; }
  return out + field;
}

export function parse(src: string): string[] {
  let fields = parseDelimitedFields(src, ",", "|");
  if (fields == "") {
    let empty: string[] = [];
    return empty;
  }
  return fields.split("|");
}

export function parseDelimited(src: string, delimiter: string): string[] {
  let fields = parseDelimitedFields(src, delimiter, "|");
  if (fields == "") {
    let empty: string[] = [];
    return empty;
  }
  return fields.split("|");
}

export function rowCount(src: string): int {
  if (src == "") { return 0; }
  let count: int = 1;
  let inQuotes: bool = false;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (inQuotes) {
      if (c == "\"") {
        if (i + 1 < src.length && src.charAt(i + 1) == "\"") { i = i + 2; }
        else { inQuotes = false; i = i + 1; }
      } else { i = i + 1; }
    } else if (c == "\"") {
      inQuotes = true;
      i = i + 1;
    } else if (c == "\n") {
      if (i + 1 < src.length) { count = count + 1; }
      i = i + 1;
    } else if (c == "\r") {
      let step: int = 1;
      if (i + 1 < src.length && src.charAt(i + 1) == "\n") { step = 2; }
      if (i + step < src.length) { count = count + 1; }
      i = i + step;
    } else {
      i = i + 1;
    }
  }
  return count;
}

function colCountWithDelimiter(src: string, row: int, delimiter: string): int {
  if (src == "") { return 0; }
  let currentRow: int = 0;
  let cols: int = 1;
  let sawCell: bool = false;
  let inQuotes: bool = false;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (inQuotes) {
      if (c == "\"") {
        if (i + 1 < src.length && src.charAt(i + 1) == "\"") { i = i + 2; }
        else { inQuotes = false; i = i + 1; }
      } else {
        if (currentRow == row) { sawCell = true; }
        i = i + 1;
      }
    } else if (c == "\"") {
      inQuotes = true;
      if (currentRow == row) { sawCell = true; }
      i = i + 1;
    } else if (c == delimiter) {
      if (currentRow == row) { cols = cols + 1; sawCell = true; }
      i = i + 1;
    } else if (c == "\n" || c == "\r") {
      if (currentRow == row) { return cols; }
      currentRow = currentRow + 1;
      cols = 1;
      sawCell = false;
      if (c == "\r" && i + 1 < src.length && src.charAt(i + 1) == "\n") { i = i + 2; }
      else { i = i + 1; }
    } else {
      if (currentRow == row) { sawCell = true; }
      i = i + 1;
    }
  }
  if (currentRow == row && sawCell) { return cols; }
  return 0;
}

export function colCount(src: string, row: int): int {
  return colCountWithDelimiter(src, row, ",");
}

function getWithDelimiter(src: string, row: int, col: int, fallback: string, delimiter: string): string {
  let currentRow: int = 0;
  let currentCol: int = 0;
  let field = "";
  let inQuotes: bool = false;
  let i: int = 0;
  while (i < src.length) {
    let c = src.charAt(i);
    if (inQuotes) {
      if (c == "\"") {
        if (i + 1 < src.length && src.charAt(i + 1) == "\"") {
          if (currentRow == row && currentCol == col) { field = field + "\""; }
          i = i + 2;
        } else {
          inQuotes = false;
          i = i + 1;
        }
      } else {
        if (currentRow == row && currentCol == col) { field = field + c; }
        i = i + 1;
      }
    } else if (c == "\"") {
      inQuotes = true;
      i = i + 1;
    } else if (c == delimiter) {
      if (currentRow == row && currentCol == col) { return field; }
      if (currentRow == row) { field = ""; }
      currentCol = currentCol + 1;
      i = i + 1;
    } else if (c == "\n" || c == "\r") {
      if (currentRow == row && currentCol == col) { return field; }
      if (currentRow == row) { field = ""; }
      currentRow = currentRow + 1;
      currentCol = 0;
      if (c == "\r" && i + 1 < src.length && src.charAt(i + 1) == "\n") { i = i + 2; }
      else { i = i + 1; }
    } else {
      if (currentRow == row && currentCol == col) { field = field + c; }
      i = i + 1;
    }
  }
  if (currentRow == row && currentCol == col && src != "") { return field; }
  return fallback;
}

export function get(src: string, row: int, col: int, fallback: string): string {
  return getWithDelimiter(src, row, col, fallback, ",");
}

export function getDelimited(src: string, row: int, col: int, fallback: string, delimiter: string): string {
  return getWithDelimiter(src, row, col, fallback, delimiter);
}

export function headerIndex(src: string, name: string): int {
  let cols = colCount(src, 0);
  let i: int = 0;
  while (i < cols) {
    if (get(src, 0, i, "") == name) { return i; }
    i = i + 1;
  }
  return -1;
}

export function getByHeader(src: string, row: int, header: string, fallback: string): string {
  let col = headerIndex(src, header);
  if (col < 0) { return fallback; }
  return get(src, row, col, fallback);
}

function needsQuote(s: string): bool {
  return s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r");
}

function quoteField(s: string): string {
  if (!needsQuote(s)) { return s; }
  let out = "\"";
  let i: int = 0;
  while (i < s.length) {
    let c = s.charAt(i);
    if (c == "\"") { out = out + "\"\""; }
    else { out = out + c; }
    i = i + 1;
  }
  return out + "\"";
}

export function stringify(fields: string[], columns: int): string {
  return stringifyDelimited(fields, columns, ",");
}

export function stringifyDelimited(fields: string[], columns: int, delimiter: string): string {
  if (columns <= 0) { return ""; }
  let out = "";
  let i: int = 0;
  while (i < fields.length) {
    if (i > 0) {
      if (i % columns == 0) { out = out + "\n"; }
      else { out = out + delimiter; }
    }
    out = out + quoteField(fields[i]);
    i = i + 1;
  }
  return out;
}

test("parse simple csv", () => {
  let src = "name,age\nAymen,30\nLumen,1";
  let fields = parse(src);
  expect(fields.length == 6);
  expect(fields[0] == "name");
  expect(fields[1] == "age");
  expect(fields[2] == "Aymen");
  expect(fields[5] == "1");
  expect(rowCount(src) == 3);
  expect(colCount(src, 0) == 2);
  expect(get(src, 1, 0, "") == "Aymen");
  expect(headerIndex(src, "age") == 1);
  expect(getByHeader(src, 1, "name", "") == "Aymen");
});

test("quoted fields", () => {
  let src = "name,note\n\"Ada, Lovelace\",\"said \"\"hello\"\"\"";
  expect(get(src, 1, 0, "") == "Ada, Lovelace");
  expect(get(src, 1, 1, "") == "said \"hello\"");
});

test("newlines inside quoted fields", () => {
  let src = "id,note\n1,\"line one\nline two\"\n2,end";
  expect(rowCount(src) == 3);
  expect(get(src, 1, 1, "") == "line one\nline two");
  expect(get(src, 2, 1, "") == "end");
});

test("empty fields and crlf", () => {
  let src = "a,b,c\r\n1,,3\r\n,,";
  expect(rowCount(src) == 3);
  expect(colCount(src, 1) == 3);
  expect(get(src, 1, 1, "x") == "");
  expect(get(src, 2, 0, "x") == "");
  expect(get(src, 9, 9, "x") == "x");
});

test("stringify fields", () => {
  let fields: string[] = ["name", "note", "Ada, Lovelace", "said \"hello\"", "Lumen", "line one\nline two"];
  let out = stringify(fields, 2);
  expect(out == "name,note\n\"Ada, Lovelace\",\"said \"\"hello\"\"\"\nLumen,\"line one\nline two\"");
  expect(get(out, 1, 0, "") == "Ada, Lovelace");
  expect(get(out, 1, 1, "") == "said \"hello\"");
  expect(get(out, 2, 1, "") == "line one\nline two");
});

test("single row and trailing newline", () => {
  expect(rowCount("a,b,c\n") == 1);
  expect(colCount("a,b,c\n", 0) == 3);
  expect(get("a,b,c\n", 0, 2, "") == "c");
});

test("custom delimiter helpers", () => {
  let src = "name;note\nAda;hello";
  let fields = parseDelimited(src, ";");
  expect(fields.length == 4);
  expect(fields[0] == "name");
  expect(getDelimited(src, 1, 1, "", ";") == "hello");
  expect(stringifyDelimited(fields, 2, ";") == "name;note\nAda;hello");
});

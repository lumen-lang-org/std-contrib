// The `@entity` decorator: a plume mapping derived from a decorated class,
// so the fields are stated once instead of twice.
//
//   @entity("agents")
//   class Agent {
//     @id @column("id", "text")
//     id: string;
//
//     @column("agent_name", "text")
//     agentName: string;
//   }
//
//   persist(database, entityAgent, JSON.stringify(a));
//
// A decorator is a pure function from a description to a value, so this is an
// ordinary function of an ordinary type — testable by calling it, with no
// compiler involved. That is the whole reason the signature is what it is.
//
// Nothing is inferred. A field without `@column` is not mapped; a class
// without `@id` has no key. Guessing `agent_name` from `agentName` would be a
// convention, and plume has none — but stating it once beside the field is not
// repetition, it is the declaration.

import { DbField, DbRepository, field, repository } from "./plume.ts";

// --- the description the compiler passes in --------------------------------
//
// Declared here rather than imported because spec 455 is not landed yet. When
// it is, the compiler provides this type and this block goes away; the
// function below does not change, which is the point of testing it now.

export type DecoratorUse = {
  name: string,
  args: string[],
};

export type FieldDescription = {
  name: string,
  type: string,
  decorators: DecoratorUse[],
};

export type Description = {
  protocol: int,
  kind: string,
  name: string,
  args: string[],
  file: string,
  line: int,
  fields: FieldDescription[],
};

// --- reading the description -----------------------------------------------

// The argument at `index` of the decorator named `name` on a field, or an
// empty string. A missing decorator and a missing argument are the same
// answer, because both mean the field did not say.
export function fieldArg(f: FieldDescription, name: string, index: int): string {
  let i: int = 0;
  while (i < f.decorators.length) {
    if (f.decorators[i].name == name) {
      if (index < f.decorators[i].args.length) { return f.decorators[i].args[index]; }
      return "";
    }
    i = i + 1;
  }
  return "";
}

export function fieldHas(f: FieldDescription, name: string): bool {
  let i: int = 0;
  while (i < f.decorators.length) {
    if (f.decorators[i].name == name) { return true; }
    i = i + 1;
  }
  return false;
}

// A column type that was not stated, derived from the declared type. This is
// the one inference here, and it is a last resort: `@column("id")` with no
// type still has to produce something, and the annotation is the only other
// evidence. `@column("id", "text")` overrides it.
export function defaultSqlType(declared: string): string {
  if (declared == "int" || declared == "i32" || declared == "i64") { return "int"; }
  if (declared == "number" || declared == "f64") { return "float8"; }
  if (declared == "bool" || declared == "boolean") { return "bool"; }
  return "text";
}

// --- the decorator ---------------------------------------------------------

// Why this returns a `DbRepository` and not a string of Lumen: the return type
// is declared, so the checker verifies it, and a mistake is reported against
// this signature rather than against a generated line nobody wrote.
export function entity(d: Description): DbRepository {
  let fields: DbField[] = [];
  let idField = "";
  let idColumn = "";

  let i: int = 0;
  while (i < d.fields.length) {
    let f = d.fields[i];
    if (fieldHas(f, "column")) {
      let column = fieldArg(f, "column", 0);
      if (column == "") { column = f.name; }
      let sqlType = fieldArg(f, "column", 1);
      if (sqlType == "") { sqlType = defaultSqlType(f.type); }
      fields.push(field(f.name, column, sqlType));
      if (fieldHas(f, "id")) {
        idField = f.name;
        idColumn = column;
      }
    }
    i = i + 1;
  }

  let table = "";
  if (d.args.length > 0) { table = d.args[0]; }
  return repository(table, idField, idColumn, fields);
}

// Whether a description would produce a usable mapping, and why not. Called by
// the decorator's own tests and usable by a program that builds a description
// by hand; `entity` itself returns whatever it was given, and
// `repositoryValid` refuses the result — the same path a hand-written mapping
// takes.
export function entityProblem(d: Description): string {
  if (d.protocol != 1) {
    return "this decorator understands description protocol 1, not " + `${d.protocol}`;
  }
  if (d.kind != "class") {
    return "@entity goes on a class, not on a " + d.kind;
  }
  if (d.args.length == 0 || d.args[0] == "") {
    return "@entity needs a table name: @entity(\"agents\")";
  }
  let mapped: int = 0;
  let keys: int = 0;
  let i: int = 0;
  while (i < d.fields.length) {
    if (fieldHas(d.fields[i], "column")) { mapped = mapped + 1; }
    if (fieldHas(d.fields[i], "id")) {
      keys = keys + 1;
      if (!fieldHas(d.fields[i], "column")) {
        return "the key field \"" + d.fields[i].name + "\" has @id but no @column, so it has no column to be the key of";
      }
    }
    i = i + 1;
  }
  if (mapped == 0) {
    return "no field of " + d.name + " has @column, so there is nothing to map";
  }
  if (keys == 0) {
    return d.name + " has no @id field, and a mapping needs a key";
  }
  if (keys > 1) {
    return d.name + " has " + `${keys}` + " @id fields, and a mapping has one key";
  }
  return "";
}

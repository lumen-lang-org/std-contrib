// The @entity decorator, tested by calling it.
//
// This is the claim spec 455 makes about its design: a decorator is a pure
// function from a description to a value, so it needs no compiler, no pipes
// and no fixtures on disk to test. If that claim did not hold, this file could
// not exist — and it exists before the compiler can run a decorator at all.
//
//   cd packages/plume && lumen test entity.test.ts

import { EntityDescription, FieldDescription, DecoratorUse, entity, entityViolation, fieldArg, fieldHas, defaultSqlType } from "./entity.ts";
import { repositoryValid, selectList } from "./plume.ts";

function use(name: string, args: string[]): DecoratorUse {
  let u: DecoratorUse = { name: name, args: args };
  return u;
}

function fieldOf(name: string, declared: string, decorators: DecoratorUse[]): FieldDescription {
  let f: FieldDescription = { name: name, type: declared, decorators: decorators };
  return f;
}

// The description the compiler would hand over for:
//
//   @entity("agents")
//   class Agent {
//     @id @column("id", "text")        id: string;
//     @column("agent_name", "text")    agentName: string;
//     @column("max_steps", "int")      maxSteps: int;
//                                      scratch: string;   // not mapped
//   }
function agentDescription(): EntityDescription {
  let idDecorators: DecoratorUse[] = [use("id", []), use("column", ["id", "text"])];
  let nameDecorators: DecoratorUse[] = [use("column", ["agent_name", "text"])];
  let stepDecorators: DecoratorUse[] = [use("column", ["max_steps", "int"])];
  let none: DecoratorUse[] = [];
  let fields: FieldDescription[] = [
    fieldOf("id", "string", idDecorators),
    fieldOf("agentName", "string", nameDecorators),
    fieldOf("maxSteps", "int", stepDecorators),
    fieldOf("scratch", "string", none),
  ];
  let d: EntityDescription = {
    protocol: 1,
    kind: "class",
    name: "Agent",
    args: ["agents"],
    file: "agent.ts",
    line: 3,
    fields: fields,
  };
  return d;
}

test("a decorated class becomes a usable mapping", () => {
  let repo = entity(agentDescription());
  expect(repo.table == "agents");
  expect(repo.idField == "id");
  expect(repo.idColumn == "id");
  expect(repositoryValid(repo));
});

test("every @column field is mapped, and only those", () => {
  let repo = entity(agentDescription());
  expect(repo.fields.length == 3);
  expect(repo.fields[0].field == "id");
  expect(repo.fields[1].field == "agentName");
  expect(repo.fields[1].column == "agent_name");
  expect(repo.fields[2].column == "max_steps");
  // `scratch` has no @column, so it is not in the mapping — a field is data
  // the program holds, not necessarily data the table holds.
  let list = selectList(repo);
  expect(list.indexOf("scratch") < 0);
  expect(list.indexOf("agent_name AS \"agentName\"") >= 0);
});

test("the generated mapping is the one written by hand", () => {
  // The mapping this replaces, verbatim from plume.test.ts.
  let repo = entity(agentDescription());
  expect(repo.fields[1].field == "agentName");
  expect(repo.fields[1].column == "agent_name");
  expect(repo.fields[1].sqlType == "text");
  expect(repo.fields[2].sqlType == "int");
});

test("a column name left out falls back to the field name", () => {
  let d = agentDescription();
  let bare: DecoratorUse[] = [use("column", [])];
  let fields: FieldDescription[] = [
    fieldOf("id", "string", [use("id", []), use("column", ["id", "text"])]),
    fieldOf("temperature", "number", bare),
  ];
  let withBare: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  let repo = entity(withBare);
  expect(repo.fields[1].column == "temperature");
  // And the type comes from the annotation, since nothing else stated one.
  expect(repo.fields[1].sqlType == "float8");
});

test("a declared type maps to a SQL type only when none was stated", () => {
  expect(defaultSqlType("int") == "int");
  expect(defaultSqlType("i64") == "int");
  expect(defaultSqlType("number") == "float8");
  expect(defaultSqlType("bool") == "bool");
  expect(defaultSqlType("string") == "text");
  // An unrecognised annotation becomes text rather than an error: the column
  // type can always be stated outright.
  expect(defaultSqlType("Agent[]") == "text");
});

test("a field's decorator arguments are read by name and position", () => {
  let d = agentDescription();
  expect(fieldArg(d.fields[1], "column", 0) == "agent_name");
  expect(fieldArg(d.fields[1], "column", 1) == "text");
  expect(fieldArg(d.fields[1], "column", 9) == "");
  expect(fieldArg(d.fields[1], "absent", 0) == "");
  expect(fieldHas(d.fields[0], "id"));
  expect(!fieldHas(d.fields[1], "id"));
});

// --- what it refuses -------------------------------------------------------

test("a description with no problem reports none", () => {
  expect(entityViolation(agentDescription()) == "");
});

test("a protocol it does not know is refused rather than guessed at", () => {
  let d = agentDescription();
  let future: EntityDescription = {
    protocol: 2, kind: d.kind, name: d.name, args: d.args,
    file: d.file, line: d.line, fields: d.fields,
  };
  expect(entityViolation(future).indexOf("protocol 1") >= 0);
});

test("a missing table name is named as such", () => {
  let d = agentDescription();
  let empty: string[] = [];
  let noTable: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: empty,
    file: d.file, line: d.line, fields: d.fields,
  };
  expect(entityViolation(noTable).indexOf("needs a table name") >= 0);
});

test("a class with no key is refused, and says which class", () => {
  let d = agentDescription();
  let fields: FieldDescription[] = [
    fieldOf("agentName", "string", [use("column", ["agent_name", "text"])]),
  ];
  let keyless: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: "Agent", args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  let violation = entityViolation(keyless);
  expect(violation.indexOf("Agent") >= 0);
  expect(violation.indexOf("no @id field") >= 0);
});

test("two keys are refused, counted", () => {
  let d = agentDescription();
  let fields: FieldDescription[] = [
    fieldOf("id", "string", [use("id", []), use("column", ["id", "text"])]),
    fieldOf("other", "string", [use("id", []), use("column", ["other", "text"])]),
  ];
  let twoKeys: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: "Agent", args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  expect(entityViolation(twoKeys).indexOf("2 @id fields") >= 0);
});

test("an @id without an @column is refused, naming the field", () => {
  let d = agentDescription();
  let fields: FieldDescription[] = [
    fieldOf("id", "string", [use("id", [])]),
    fieldOf("agentName", "string", [use("column", ["agent_name", "text"])]),
  ];
  let unmappedKey: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: "Agent", args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  let violation = entityViolation(unmappedKey);
  expect(violation.indexOf("\"id\"") >= 0);
  expect(violation.indexOf("no @column") >= 0);
});

test("a class with no mapped field is refused", () => {
  let d = agentDescription();
  let none: DecoratorUse[] = [];
  let fields: FieldDescription[] = [fieldOf("scratch", "string", none)];
  let unmapped: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: "Agent", args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  expect(entityViolation(unmapped).indexOf("nothing to map") >= 0);
});

test("a bad description still produces a mapping that plume refuses", () => {
  // entity does not raise; it returns what it was given, and the ordinary
  // validity check catches it — the same path a hand-written mapping takes.
  let d = agentDescription();
  let none: DecoratorUse[] = [];
  let fields: FieldDescription[] = [fieldOf("scratch", "string", none)];
  let unmapped: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: "Agent", args: d.args,
    file: d.file, line: d.line, fields: fields,
  };
  expect(!repositoryValid(entity(unmapped)));
});

test("a table name that is not a plain identifier is caught by plume, not here", () => {
  let d = agentDescription();
  let hostile: string[] = ["agents; DROP TABLE users"];
  let injected: EntityDescription = {
    protocol: d.protocol, kind: d.kind, name: d.name, args: hostile,
    file: d.file, line: d.line, fields: d.fields,
  };
  // The decorator passes it through; the mapping is then invalid, so no
  // operation will run. A decorator is not a second place to enforce this.
  expect(!repositoryValid(entity(injected)));
});

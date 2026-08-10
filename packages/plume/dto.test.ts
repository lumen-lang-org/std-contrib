// The @dto decorator, tested by calling it.
//
// Same claim as entity.test.ts: a decorator is a pure function from a
// description to a value, so it needs no compiler, no pipes and no fixtures on
// disk. The descriptions below are what the compiler would hand over; building
// them by hand is the whole point.
//
//   cd packages/plume && lumen test dto.test.ts

import { Description, DtoFieldDescription, DtoDecoratorUse, Projection, dto, shapeViolation, narrowTo, columnViolation, coverageViolation, documentViolation, writeViolation } from "./dto.ts";
import { DbField, DbRepository, field, repository } from "./plume.ts";

// The description this decorator asks for, built by hand. It is narrower than
// the one the compiler holds — @dto never reads a file name, a line or an
// argument — and that narrowing is what keeps it working when the description
// format grows.
function use(name: string): DtoDecoratorUse {
  let u: DtoDecoratorUse = { name: name };
  return u;
}

function fieldOf(name: string, decorators: DtoDecoratorUse[]): DtoFieldDescription {
  let f: DtoFieldDescription = { name: name, decorators: decorators };
  return f;
}

function describe(name: string, fields: DtoFieldDescription[]): Description {
  let none: string[] = [];
  let d: Description = { protocol: 1, kind: "class", name: name, args: none, fields: fields };
  return d;
}

// The description the compiler would hand over for:
//
//   @dto
//   class AgentEdit {
//     id: string;
//     agentName: string;
//     enabled: bool;
//   }
function agentEdit(): Description {
  let none: DtoDecoratorUse[] = [];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("agentName", none),
    fieldOf("enabled", none),
  ];
  return describe("AgentEdit", fields);
}

// The table those three are columns of, plus one they are not.
function agentsTable(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("enabled", "enabled", "bool"),
    field("promptId", "prompt_id", "text"),
  ];
  return repository({
    table: "agents",
    idField: "id",
    idColumn: "id",
    fields: fields,
    relations: [],
  });
}

test("every field of the record becomes a key of the shape", () => {
  let p = dto(agentEdit());
  expect(p.name == "AgentEdit");
  expect(p.fields.length == 3);
  expect(p.fields[0] == "id");
  expect(p.fields[1] == "agentName");
  expect(p.fields[2] == "enabled");
  // Nothing was annotated, so nothing is an extra. That is the design: a field
  // is from the entity unless it says otherwise.
  expect(p.extras.length == 0);
});

test("the keys keep the order the record declared them in", () => {
  // Not decoration: a narrowed document is diffed, logged and compared, and
  // keys that move between builds make every diff noise.
  let p = dto(agentEdit());
  let out = narrowTo(p, "{\"enabled\":true,\"agentName\":\"Support\",\"id\":\"a1\"}");
  expect(out == "{\"id\":\"a1\",\"agentName\":\"Support\",\"enabled\":true}");
});

test("narrowing drops what the shape does not declare", () => {
  // The real case: GET /agents answers this, PUT /agents/:id accepts the row.
  let full = "{\"id\":\"a1\",\"agentName\":\"Support\",\"enabled\":true,"
    + "\"prompt\":{\"id\":\"p1\",\"body\":\"You are…\"},"
    + "\"subAgents\":[{\"id\":\"a2\"},{\"id\":\"a3\"}]}";
  let out = narrowTo(dto(agentEdit()), full);
  expect(out == "{\"id\":\"a1\",\"agentName\":\"Support\",\"enabled\":true}");
});

test("a nested object carrying a key of the shape does not confuse the narrowing", () => {
  // `prompt` holds an `id` of its own. A scan that did not step over nested
  // objects would take it, and the row would be stored under the prompt's id.
  let full = "{\"prompt\":{\"id\":\"p1\"},\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":false}";
  let out = narrowTo(dto(agentEdit()), full);
  expect(out == "{\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":false}");
});

test("a key the document does not carry is left out of the narrowed document", () => {
  // Records here have no optional fields, so a null would be refused by the
  // JSON.parse this feeds. Absent is the honest answer *for a read*. For a
  // write it is a trap, which is what the next three tests are about.
  let out = narrowTo(dto(agentEdit()), "{\"id\":\"a1\"}");
  expect(out == "{\"id\":\"a1\"}");
});

test("a document that does not carry every key of the shape says which is missing", () => {
  // The hazard `narrowTo` alone cannot see: `persist` is an upsert over every
  // column, so a key dropped here is not left alone in the row, it is written
  // as null over whatever was there. dto_applied.test.ts does that against a
  // real database; this is the check that stops it.
  let p = dto(agentEdit());
  let violation = documentViolation(p, "{\"id\":\"a1\",\"agentName\":\"Renamed\"}");
  expect(violation.includes("AgentEdit"));
  expect(violation.includes("enabled"));
});

test("a document carrying every key of the shape has no fault to report", () => {
  let p = dto(agentEdit());
  expect(documentViolation(p, "{\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":true}") == "");
  // Keys the shape does not declare are narrowing's business, not this one's.
  expect(documentViolation(p, "{\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":true,\"prompt\":{\"id\":\"p1\"}}") == "");
});

test("a document is not asked for a field marked @extra", () => {
  // An @extra field is the program's, not the table's: the handler fills it in
  // and no column is written from it, so a document that omits it writes
  // nothing over.
  let none: DtoDecoratorUse[] = [];
  let extra: DtoDecoratorUse[] = [use("extra")];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("turnsToday", extra),
  ];
  let p = dto(describe("AgentBrief", fields));
  expect(documentViolation(p, "{\"id\":\"a1\"}") == "");
});

test("a nested object carrying a key of the shape does not satisfy the check", () => {
  // Same trap as the narrowing: `prompt` holds an `id`, and a scan that did not
  // step over nested objects would call `promptId` covered because the text
  // "promptId" appears somewhere.
  let none: DtoDecoratorUse[] = [];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("promptId", none),
  ];
  let p = dto(describe("AgentEdit", fields));
  let violation = documentViolation(p, "{\"id\":\"a1\",\"prompt\":{\"promptId\":\"p1\"}}");
  expect(violation.includes("promptId"));
});

test("the write path asks the shape, the table and the document in one call", () => {
  // Three ways to lose a column, and a write route that remembers two of them
  // is a write route that loses the third.
  let p = dto(agentEdit());
  let full = "{\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":true}";
  // The shape drops promptId, which the table stores: refused before the
  // document is even looked at.
  expect(writeViolation(p, agentsTable(), full).includes("promptId"));

  let none: DtoDecoratorUse[] = [];
  let whole: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("agentName", none),
    fieldOf("enabled", none),
    fieldOf("promptId", none),
  ];
  let w = dto(describe("AgentWhole", whole));
  expect(writeViolation(w, agentsTable(), "{\"id\":\"a1\",\"agentName\":\"S\",\"enabled\":true,\"promptId\":\"p1\"}") == "");
  expect(writeViolation(w, agentsTable(), full).includes("promptId"));
});

test("a shape that names something the table does not have says which", () => {
  let none: DtoDecoratorUse[] = [];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("agentNmae", none),
  ];
  let violation = columnViolation(dto(describe("Typo", fields)), agentsTable());
  expect(violation.includes("agentNmae"));
  expect(violation.includes("agents"));
  expect(violation.includes("@extra"));
});

test("a field marked @extra is not expected to be a column", () => {
  let none: DtoDecoratorUse[] = [];
  let extra: DtoDecoratorUse[] = [use("extra")];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("agentName", none),
    fieldOf("enabled", none),
    fieldOf("turnsToday", extra),
  ];
  let p = dto(describe("AgentBrief", fields));
  expect(p.extras.length == 1);
  expect(p.extras[0] == "turnsToday");
  expect(columnViolation(p, agentsTable()) == "");
});

test("a shape that drops a column the table stores can say so when asked", () => {
  // Deliberately not part of columnViolation: a shape that covers part of a row is
  // a legitimate thing to want, and only the caller knows which it is.
  let p = dto(agentEdit());
  expect(columnViolation(p, agentsTable()) == "");
  let covers = coverageViolation(p, agentsTable());
  expect(covers.includes("promptId"));
  expect(covers.includes("agents"));
});

test("a description from a future protocol is refused rather than misread", () => {
  let d = agentEdit();
  let ahead: Description = {
    protocol: 2,
    kind: d.kind,
    name: d.name,
    args: d.args,
    fields: d.fields,
  };
  expect(shapeViolation(ahead).includes("protocol 1"));
});

test("@dto on something that is not a class is refused", () => {
  let d = agentEdit();
  let fn: Description = {
    protocol: 1,
    kind: "function",
    name: d.name,
    args: d.args,
    fields: d.fields,
  };
  expect(shapeViolation(fn).includes("not on a function"));
});

test("a record with no fields is refused, because it narrows everything to nothing", () => {
  let empty: DtoFieldDescription[] = [];
  expect(shapeViolation(describe("Nothing", empty)).includes("no fields"));
});

test("@dto with an argument is refused rather than having the argument dropped", () => {
  // `@dto("agents")` used to compile and mean `@dto`. A decorator that accepts
  // what it will not read teaches the next reader that it reads it.
  let d = agentEdit();
  let with_arg: Description = {
    protocol: 1,
    kind: d.kind,
    name: d.name,
    args: ["agents"],
    fields: d.fields,
  };
  let violation = shapeViolation(with_arg);
  expect(violation.includes("agents"));
  expect(violation.includes("no arguments"));
});

test("a field declared twice is refused", () => {
  let none: DtoDecoratorUse[] = [];
  let fields: DtoFieldDescription[] = [
    fieldOf("id", none),
    fieldOf("id", none),
  ];
  expect(shapeViolation(describe("Twice", fields)).includes("twice"));
});

test("a usable description has no fault to report", () => {
  expect(shapeViolation(agentEdit()) == "");
});

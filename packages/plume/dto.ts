// The `@dto` decorator: the shape a record is allowed to arrive in, taken
// from the record itself.
//
//   @dto
//   class AgentEdit {
//     id: string;
//     agentName: string;
//     description: string;
//     modelConfigId: string;
//     promptId: string;
//     enabled: bool;
//     isDefault: bool;
//   }
//
//   let violation = writeViolation(dtoAgentEdit, agentsMapping(), req.body);
//   if (violation != "") { return badRequest(fault); }
//   persist(database, agentsMapping(), narrowTo(dtoAgentEdit, req.body));
//
// The check is not decoration and it is not optional on a write path. `persist`
// is an upsert over every column of the mapping, so a key the document did not
// carry is not left alone in the row: on a nullable column it is written as
// null over whatever was there, with `ok = true` and nothing reported, and on a
// NOT NULL column the statement fails and takes the rest of the update with it.
// A schema that happens to forbid null is the only thing that has ever caught
// this, which is luck rather than a design. Narrowing drops absent keys, which
// is right for a read and a loaded gun for a write, and `narrowTo` cannot tell
// which it is being used for. So the projection is asked instead: see
// `documentViolation` and `writeViolation` at the bottom of this file.
//
// # Why this exists
//
// `JSON.parse<T>` rejects a document carrying a field the target does not
// declare — rightly, because a client sending `enabld: true` should hear about
// it. But a read route answers more than a write route accepts: GET /agents
// nests the prompt, the model config, the servers and the sub-agents, and
// PUT /agents/:id takes the seven columns. So a caller cannot send back the
// document it was given, and every caller has had to rebuild the row by hand —
// four times over, in this repo, and none of the four learns about a new
// column.
//
// `pickFields` in plume.ts has been able to do the narrowing since the day it
// was written. What was missing was the list of keys. This is the list of keys,
// and its only claim is that it is not written twice: the record declares the
// fields, and the decorator reads them off the record.
//
// # Why there is nothing to annotate
//
// `@entity` needs `@column` on every field because it crosses a namespace:
// `agentName` here is `agent_name` there, and guessing between them would be a
// convention plume does not have. A DTO crosses nothing — both sides are
// records in this language, and `agentName` is `agentName`. Matching by
// identity infers nothing, so there is nothing to declare, so there is no
// annotation. A field that does *not* come from the entity says so with
// `@extra`, which is the only case where the record is not evidence enough.
//
// # What it deliberately does not do
//
// No renaming. Every rename in this codebase happens in SQL, where the
// repository already aliases columns to keys, and a second renaming layer in
// front of it would give two places to look and two ways to disagree. When a
// rename between two Lumen records actually appears, it can be added; it has
// not appeared yet.
//
// # What a program using @dto has to import
//
// `import { dto } from "./dto.ts"` on its own does not compile. The decorator
// is evaluated by the compiler and its result is emitted as a record literal:
//
//   let dtoAgentEdit: Projection = { name: "AgentEdit", fields: [...], extras: [] };
//
// so `Projection` has to be a name the program knows. Importing only the
// decorator does not put it there — the module is not linked, and the error is
// `unknown type name` pointing at a line nobody wrote. Import `Projection`
// alongside `dto`, or anything else from this file, and it is in scope.
//
// # One decorator module at a time
//
// entity.ts declares a `Description` type and so does this file, because the
// compiler parses a decorator's module alone and requires that exact name in
// it. Two such modules can be used by one program, but only while at most one
// of them is *linked*: the other has to be imported for its decorator and
// nothing else. Since `@dto` needs `Projection` (above), this file is always
// the linked one, and entity.ts is the one that must stay decorator-only:
//
//   import { entity } from "./entity.ts";              // fine
//   import { entity, field } from "./entity.ts";       // E_DUPLICATE_TYPE
//
// The second line stops the compile with `type 'Description' is declared by
// both entity.ts and dto.ts`. Renaming the type here does not help — the
// compiler demands the name `Description` in a decorator's module, so the two
// cannot be told apart by their names.
//
// This is a compiler fault and it is written up as one: per lumen/CLAUDE.md,
// "two packages that break each other by choosing ordinary names are not
// misnamed — the namespace is wrong." A decorator's description type should be
// scoped to its module, or provided by the compiler as one shared type (spec
// 455), rather than required by name in every module that declares a decorator.
// Nothing in this file works around it, on purpose: a workaround here would
// have to be repeated by every future decorator module and would make the
// compiler's rule look intentional.
//
//   sh packages/plume/build.sh
//   cd packages/plume && lumen test dto.test.ts
//   cd packages/plume && lumen test dto_applied.test.ts

import { DbRepository, pickFields, jsonMember } from "./plume.ts";

// --- the description the compiler passes in --------------------------------
//
// Declared here rather than imported from entity.ts, because the compiler
// parses a decorator's module *alone* and requires `Description` in it. That
// turns out to be the useful shape anyway: the description is narrowed to what
// this type names before it arrives, so a key this decorator never asked for
// cannot break it when the format grows. @dto asks for the fields, their
// annotations, and the arguments — the last of those only so it can refuse
// them, which it cannot do for a key it does not name.

export type DtoDecoratorUse = {
  name: string,
};

export type DtoFieldDescription = {
  name: string,
  decorators: DtoDecoratorUse[],
};

export type Description = {
  protocol: int,
  kind: string,
  name: string,
  // Always empty for a correct use. Named here because a field this type does
  // not name is dropped before the decorator sees it, and a dropped argument
  // is exactly the thing `@dto("agents")` needs to be told about.
  args: string[],
  fields: DtoFieldDescription[],
};

function fieldHas(f: DtoFieldDescription, name: string): bool {
  let i: int = 0;
  while (i < f.decorators.length) {
    if (f.decorators[i].name == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

// A shape, as a list of keys. `name` is the record's, kept for the sentences
// the checks below produce — a fault that cannot say which DTO it is about
// is a fault someone has to go looking for.
export type Projection = {
  name: string,
  fields: string[],
  // Fields that are the program's, not the table's: computed, or filled in by
  // the handler. Held separately so `columnViolation` can tell "this field is
  // not in the table" from "this field is not meant to be".
  extras: string[],
};

// --- the decorator ---------------------------------------------------------

// Every field of the record, in the order it was declared. Order matters only
// because it decides the order of the keys in the narrowed document, and a
// document whose keys move around between builds is one nobody can diff.
//
// A description `shapeViolation` refuses is thrown rather than returned, and that
// is not a departure from the house convention — it is where the convention
// runs out. The compiler evaluates this function at compile time and emits its
// result as a literal, so a throw here is a compile error at the `@dto` line:
//
//   agents.ts:12:1: error: '@dto' failed:
//   dto.ts:NN:NN: Uncaught Error: @dto on "Nothing" has no fields, ...
//
// which is the earliest and cheapest place the news can be delivered. A
// sentence returned to a caller cannot be, because there is no caller: nothing
// in a program calls `dto`, the compiler does. This is not the lambda case
// either — the throw never crosses a function value, and never runs in the
// built program at all.
export function dto(d: Description): Projection {
  let violation = shapeViolation(d);
  if (violation != "") {
    throw violation;
  }
  let fields: string[] = [];
  let extras: string[] = [];
  let i: int = 0;
  while (i < d.fields.length) {
    let f = d.fields[i];
    fields.push(f.name);
    if (fieldHas(f, "extra")) {
      extras.push(f.name);
    }
    i = i + 1;
  }
  let p: Projection = { name: d.name, fields: fields, extras: extras };
  return p;
}

// Whether a description would produce a usable projection, and why not.
//
// Called by `dto` above on every applied decorator, by this decorator's own
// tests, and by any program that builds a projection by hand — the checks live
// here rather than inline so that a hand-built description takes the same path
// as a decorated one, and so that the sentences can be read without a compile.
export function shapeViolation(d: Description): string {
  if (d.protocol != 1) {
    return "this decorator understands description protocol 1, not " + `${d.protocol}`;
  }
  if (d.kind != "class") {
    return "@dto goes on a class, not on a " + d.kind;
  }
  if (d.args.length > 0) {
    return "@dto takes no arguments, but \"" + d.name + "\" passes \"" + d.args[0]
      + "\" — the shape is the record's fields, and the table it is written to is named by the mapping, not here";
  }
  if (d.fields.length == 0) {
    return "@dto on \"" + d.name + "\" has no fields, so it narrows every document to nothing";
  }
  let i: int = 0;
  while (i < d.fields.length) {
    let name = d.fields[i].name;
    let j: int = i + 1;
    while (j < d.fields.length) {
      if (d.fields[j].name == name) {
        return "\"" + d.name + "\" declares \"" + name + "\" twice";
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return "";
}

// --- the narrowing ---------------------------------------------------------

// The document, reduced to the keys this shape declares.
//
// A key the document does not carry is left out rather than written as null:
// records here have no optional fields, so a null would be refused by the very
// `JSON.parse<T>` this is feeding.
//
// That is the right answer for a read and the wrong one for a write, and this
// function cannot tell them apart. On a write, `persist` upserts every column
// of the mapping, so a key that was dropped here arrives at the row as null:
// over the stored value if the column allows null, and as a failed statement if
// it does not. Ask `writeViolation` before persisting anything narrowed by this.
export function narrowTo(p: Projection, document: string): string {
  return pickFields(document, p.fields);
}

// --- the checks that cannot happen at compile time --------------------------

// Whether every field of this shape is a field of that table.
//
// A decorator sees only the class it is on: `@dto` cannot look at the entity,
// because a decorator's arguments arrive as text and text has no fields. So the
// pairing is checked here, against the mapping the entity produced, and it is
// called by the program rather than by the compiler — once at startup, beside
// the other checks that answer with a sentence instead of a crash.
//
// This is the one thing a later compiler could do better, and the reason to
// keep the answer a sentence rather than a throw: when a description can carry
// another class, this same rule moves to compile time and the call here goes
// away without the rule changing.
export function columnViolation(p: Projection, repo: DbRepository): string {
  let i: int = 0;
  while (i < p.fields.length) {
    let name = p.fields[i];
    if (!listHas(p.extras, name)) {
      if (!repoHasField(repo, name)) {
        return "\"" + p.name + "\" names \"" + name + "\", which the "
          + repo.table + " table does not have — mark it @extra if it is not meant to be stored";
      }
    }
    i = i + 1;
  }
  return "";
}

// Whether narrowing to this shape would leave a row the table cannot store.
//
// The opposite direction of the check above, and the one that catches a column
// added to the entity and forgotten here: a field the table requires and the
// shape drops is written by nobody, and the row is stored with whatever the
// column's default is. Not called by `columnViolation`, because a shape that
// deliberately covers part of a row is a legitimate thing to want and only the
// caller knows which it is — `writeViolation` is the caller that always does.
export function coverageViolation(p: Projection, repo: DbRepository): string {
  let i: int = 0;
  while (i < repo.fields.length) {
    let name = repo.fields[i].field;
    if (!listHas(p.fields, name)) {
      return "\"" + p.name + "\" drops \"" + name + "\", which " + repo.table
        + " stores — a document narrowed to this shape cannot write it";
    }
    i = i + 1;
  }
  return "";
}

// Whether this document carries every key the shape declares.
//
// The third direction, and the one the other two cannot see: `columnViolation` and
// `coverageViolation` both read the shape against the table, and both are answered
// once at startup. This one is answered per request, because it is about the
// document that just arrived. A shape that covers the table perfectly still
// nulls a column when the document it narrows was short of a key.
//
// `@extra` fields are not asked for: they are the program's rather than the
// table's, no column is written from them, so a document that omits one
// overwrites nothing.
//
// Presence is read with `jsonMember`, not by looking for the key's text: that
// scanner steps over nested objects and strings, so an `id` inside a nested
// `prompt` does not answer for the `id` this shape means.
export function documentViolation(p: Projection, document: string): string {
  let i: int = 0;
  while (i < p.fields.length) {
    let name = p.fields[i];
    if (!listHas(p.extras, name)) {
      if (jsonMember(document, name) == "") {
        return "\"" + p.name + "\" declares \"" + name
          + "\", which this document does not carry — narrowing drops it, and persisting the"
          + " result writes null over the stored value, or fails if the column forbids null";
      }
    }
    i = i + 1;
  }
  return "";
}

// The three questions a write path has to ask, in the order that makes the
// answers useful: is the shape made of columns, does it cover the row, and did
// this document cover the shape.
//
// One call rather than three because three is how one gets forgotten — the
// hazard this exists for is not that a route asks the wrong question, it is
// that a route asks two of them. The first two answers do not change between
// requests and could be hoisted to startup; the third cannot.
export function writeViolation(p: Projection, repo: DbRepository, document: string): string {
  let names = columnViolation(p, repo);
  if (names != "") {
    return names;
  }
  let covers = coverageViolation(p, repo);
  if (covers != "") {
    return covers;
  }
  return documentViolation(p, document);
}

function listHas(names: string[], name: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function repoHasField(repo: DbRepository, name: string): bool {
  let i: int = 0;
  while (i < repo.fields.length) {
    if (repo.fields[i].field == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

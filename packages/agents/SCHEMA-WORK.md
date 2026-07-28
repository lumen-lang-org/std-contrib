# Working on a large document the model cannot hold

The task this is for: a 200KB JSON document with a schema beside it, which a
model has to write, revise across several turns, and be *right* about. Editing
it is one half — `ARTIFACT-EDITING.md` covers that. This is the other three:
finding your way around a file too big to read, checking the work, and the loop
that ties them together without burning the round.

Nothing here exists yet. The document names what has to be built, in the order
it has to be built, and what each piece must refuse to do.

## What the model is up against

**It cannot read the file.** `ARTIFACT_MAX` is 524,288 bytes — about 131k
tokens. A 200KB document is ~52k tokens, and `read_artifact` returns the body
entire. Reading it once costs a third of a large context and every later round
replays the stored call args (`threads.ts:310`) until the turn falls off the
100,000-character budget. Two reads of one big file is the round gone.

**It gets eight steps.** `MAX_TOOL_STEPS` is 8 (`run.ts:46`) — every tool call
and every delegation counts. A naive fix loop is read → edit → validate, three
steps per correction, so two corrections and the round stops without an answer.
Anything designed here has to be counted against that budget, not hoped about.

**It cannot check its own work.** Nothing in this package validates a document
against a schema. `JSON.parse<T>` checks a *Lumen record* — unknown and missing
fields — which is a different thing from `$ref`, `oneOf` and
`patternProperties`. So today a model writes a large schema-bound document and
asserts it is correct, which is the failure mode that matters: not a wrong
answer, a confidently wrong one.

## The three tools

### `outline_artifact(path, depth)`

The structure without the content. For a JSON document, the key paths and the
type at each — `/servers/0/endpoint: string`, `/routes: array[42]` — to a
bounded depth, with arrays reported as a length and their first element's shape
rather than element by element.

This is the tool that makes the rest affordable. An outline of a 200KB document
is a few hundred lines; it tells the model where the thing it wants lives, and
`search_artifacts` then finds the exact text to echo into `edit_artifact`.
Without it every edit begins with a full read.

Refuses: a body that is not JSON (say so, do not guess); a depth beyond a fixed
ceiling, because an outline that approaches the size of the document is not an
outline.

### `validate_artifact(path, schemaPath)`

One artifact checked against another that holds a JSON Schema. Both are paths in
this conversation, so a schema is a document like any other — versioned,
editable, and itself checkable.

The answer is **addressed**, because an error the model cannot locate is an
error it will fix by rewriting:

```
{"ok": false, "errors": [
  {"at": "/servers/3/transport", "was": "\"stdio\"", "expected": "one of: http"},
  {"at": "/servers/3", "was": "", "expected": "required member \"endpoint\""}
]}
```

`at` is a JSON Pointer, which is what lets the model go straight to
`search_artifacts` for that member rather than reading the file.

**Errors are capped.** A type changed near the root of a schema produces one
error per instance — thousands, for a large document — and a tool result of
thousands of errors is a context wipe, not a diagnosis. Report the first N,
grouped by `at` prefix, and say how many were dropped. A truncated list that
admits it is truncated is usable; a truncated list that does not is a lie.

### The validator itself

JSON Schema is large and Lumen has no RegExp, so the honest scope is a stated
subset, refusing the rest **by name**:

Supported: `type`, `required`, `properties`, `additionalProperties`, `items`,
`enum`, `const`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/
`maxItems`, `uniqueItems`, `$ref` within the same document, `allOf`, `anyOf`,
`oneOf`, `not`.

Refused, at the point the schema is loaded rather than silently ignored while
checking: `pattern`, `patternProperties`, `format`, remote `$ref`, `$dynamicRef`
and anything else unrecognised. A validator that ignores a keyword it does not
know reports a document as valid that its author has good reason to think was
checked — which is worse than having no validator, because it is trusted.

`pattern` is the sharp one: it is common, and it needs a regex engine the
language does not have. Refusing it by name means an author knows to express
that constraint another way; ignoring it means they find out in production.

## The loop

What the agent actually does, and what it costs in steps:

```
outline_artifact(doc)                 1   where things are
search_artifacts("transport")         2   the exact text, in this file and others
edit_artifact(doc, old, new)          3   the change
validate_artifact(doc, schema)        4   did it hold
edit_artifact(doc, old2, new2)        5   the next correction
validate_artifact(doc, schema)        6   again
                                      7-8 headroom
```

Six steps for two corrections and a check, inside a budget of eight. That is
tight but real, and it is only reachable because the outline and the search
replace the reads. The same loop with `read_artifact` costs 52k tokens per pass
and stops after one.

Three rules make it terminate:

1. **Validate is the last thing, not the first.** A round that begins by
   validating spends a step learning what it already knew from the last round.
2. **The same error twice ends the loop.** If a validation returns an error at
   the same `at` with the same `expected` as the previous call in this round,
   the tool says so in its reply — *"unchanged since the last check"* — and the
   model is told plainly that its edit did not do what it thought. Without this
   a wrong fix is retried until the step budget ends the round with no answer.
3. **A failed validation is not a failed round.** The document is already
   written; the answer says what is still wrong and where. A round that stores
   nothing because the schema did not hold loses the work.

## Failure table

| what goes wrong | when it is caught |
|---|---|
| the document is not JSON | `outline_artifact` and `validate_artifact` both refuse, naming the offset |
| the schema is not JSON | refused, naming the schema's path — not the document's |
| the schema uses an unsupported keyword | refused when the schema loads, naming the keyword |
| `$ref` points outside the document | refused; there is no fetching |
| `$ref` is circular | refused at load, with the cycle named |
| thousands of errors | capped, grouped, and the count of what was dropped is reported |
| the model edits the schema instead of the document | not caught — they are both artifacts and both editable, deliberately. The paths are the model's to keep straight |
| an edit fixes one error and breaks another | caught by the next validation, which is why validation follows every edit rather than every round |
| the same error survives an edit | reported as unchanged, and the loop stops |

The one uncaught row is deliberate and worth stating: a schema is an artifact,
so a model may edit it. Making schemas read-only would prevent this and also
prevent the thing this is for — a schema and its document evolving together.

## Build order

1. **`outline_artifact`**, with the JSON scanner from `scan.ts` and a depth
   ceiling. Testable alone, and useful alone: it makes big documents navigable
   before anything can validate them.
2. **The validator core** — types, `required`, `properties`, `items`, `enum`,
   `const`, the bounds. No `$ref` yet. Every rule with a test that fails first,
   and a test per refused keyword asserting the refusal names it.
3. **`$ref` within the document**, plus cycle detection.
4. **The combinators** — `allOf`, `anyOf`, `oneOf`, `not` — last, because their
   error messages are the hard part: "failed all of anyOf" tells a model
   nothing, and the useful message names the branch that came closest.
5. **`validate_artifact`** as a tool: the addressing, the cap, and the
   unchanged-since-last-check rule.
6. **An e2e** that drives the whole loop through the composer: a document, a
   schema, a deliberate violation, and the agent finding and fixing it inside
   one round.

## What this does not do

**It does not run anything.** A real JSON Schema validator exists in every
ecosystem and running one would be less work than writing this — that is spec
480 (`confined-spawn`), and it stays out of reach until a command can be run
without handing the host's credentials to whatever a retrieved document asked
the model to say. When 480 lands, this validator becomes the offline fallback
rather than the only answer.

**It does not diff.** A model that has an outline, a search and an edit does not
need one, and a diff tool is a second way to say the same thing with its own
failure modes.

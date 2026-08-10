# validation

Validation written on the fields it validates.

```ts
@validated
class Ask {
  @required("a site key is needed")
  @maxLength(200, "that is not a site key")
  siteKey: string;

  @min(1, "at least one try")
  @max(10, "ten tries is the ceiling")
  tries: int;
}
```

```ts
let wrong = faults(Class.decorator(new Ask(...), "validated"), req.body);
if (wrong.length > 0) { return badRequest(faultsJson(wrong)); }
let ask = JSON.parse<Ask>(req.body);
```

## A list, not a sentence

`faults` returns every fault, each naming its field:

```json
[{"field":"siteKey","said":"that is not a site key"},
 {"field":"tries","said":"ten tries is the ceiling"}]
```

A client fixing three mistakes makes one round trip, and a handler can branch on
`field` rather than matching on prose.

## What it does not do

Shapes. `JSON.parse<T>` already refuses a body that omits a declared field,
sends one the type does not name, or sends the wrong kind of value, and it names
the field (spec 483). This is only for what a type cannot say: how long, how
many, how few.

So the two run in order — values first, because the messages are yours, then the
parse, whose refusal is the library's.

## The rules

| annotation | holds when |
|---|---|
| `@required(said)` | the field is present and not blank |
| `@maxLength(n, said)` | at most n bytes |
| `@minLength(n, said)` | at least n bytes, when present |
| `@max(n, said)` | at most n |
| `@min(n, said)` | at least n |

The message is optional. Without one a rule still says which field and what it
wanted, so a forgotten message is a plainer sentence rather than a silent pass.

## How it reads the annotations

`@validated` runs while compiling. It is handed every field and every annotation
written on it, and leaves a `Rule[]` constant the class carries; `faults` reads
that at run time through `Class.decorator`. Nothing is scanned or reflected on
at run time, and nothing about the class survives into the binary that was not
already there.

Arguments arrive through `argsText` (spec 484): `@maxLength(200, "…")` mixes an
int and a string, and a Lumen array is homogeneous, so the description carries
every argument spelled as text and this package parses back the number.

## Testing

```sh
cd packages/validation
lumen test validation.test.ts    # 7
```

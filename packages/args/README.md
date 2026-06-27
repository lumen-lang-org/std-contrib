# args

Command-line flag and option parsing.

## Runtime API (reads the process arguments)

| Function | Signature |
|----------|-----------|
| `hasFlag` | `(name: string) => bool` |
| `optionValue` | `(name: string, fallback: string) => string` |
| `positional` | `(index: int) => string` |

```ts
let out = optionValue("--out", "a.bin");
let verbose = hasFlag("--verbose");
let input = positional(0);   // first non-flag argument
console.log(out);
```

## Pure API (operate on an explicit argv)

`hasFlagIn(argv, name)`, `optionValueIn(argv, name, fallback)`,
`positionalIn(argv, index)` — same logic over a `string[]` you provide. These are
what the tests exercise:

```ts
let argv: string[] = ["build", "--out", "a.bin"];
optionValueIn(argv, "--out", "x");   // "a.bin"
```

Note: `arg(0)` is the program name (as in C). A `process.argv: string[]` helper
will arrive once growable arrays land, at which point the runtime and pure APIs
unify.

Test: `lumen test packages/args/args.ts`

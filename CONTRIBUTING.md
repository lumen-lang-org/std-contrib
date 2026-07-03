# Contributing a package

## Layout

Add one directory under `packages/<name>/`:

- `<name>.ts` — the package source. For now, include `test("…", () => { expect(…) })`
  blocks in the same file.
- `README.md` — what it does, the public functions, and a usage snippet.

Then add an entry to the root `index.json`.

## Rules

- **Current language only.** Use features that compile today. If it does not
  compile with the released `lumen`, it cannot be merged. New stdlib features
  such as `Map`, `Set`, and typed `JSON` are allowed once they are available in
  the released compiler used by CI.
- **Statically typed.** Annotate parameters and return types. No reliance on
  dynamic behavior.
- **Tested.** Ship `test` blocks that cover the package. CI runs `lumen test` on
  every package.
- **Self-contained.** A package should not depend on another package yet (no
  cross-package imports until the module system supports it).
- **Small and focused.** One clear concern per package.
- **Naming.** Lowercase, short, descriptive directory name (`mathx`, `geo`).

## Check it locally

```sh
lumen test packages/<name>/<name>.ts
```

It must report `All N tests passed.` with a zero exit code.

## index.json entry

```json
{ "name": "<name>", "version": "0.1.0", "summary": "one line.", "path": "packages/<name>" }
```

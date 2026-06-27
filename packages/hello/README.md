# hello

The smallest possible package — a single `greet` function. Used as the canonical
example for importing a module directly from a URL.

## Use

```ts
import greet from "https://lumen-lang.org/package/std-contrib/hello/hello.ts";

console.log(greet("world"));
```

## API

- `greet(name: string): string` — returns `"Hello, <name>!"`.

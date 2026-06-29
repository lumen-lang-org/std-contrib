# greeter

A two-file package that demonstrates recursive (URL-relative) imports: importing
`greeter.ts` from a URL also fetches its sibling `./shout.ts`.

## Use

```ts
import greeter from "https://lumen-lang.org/package/std-contrib/greeter/greeter.ts";

console.log(greeter("Lumen"));
```

## API

- `greeter(name: string): string` — returns `"Hey <name>!!!"`.

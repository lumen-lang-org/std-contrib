# greeter

A two-file package that demonstrates recursive (URL-relative) imports: importing
`greeter.ts` from a URL also fetches its sibling `./shout.ts`.

## Use

```ts
import greeter from "https://raw.githubusercontent.com/lumen-lang-org/std-contrib/main/packages/greeter/greeter.ts";

console.log(greeter("Lumen"));
```

## API

- `greeter(name: string): string` — returns `"Hey <name>!!!"`.

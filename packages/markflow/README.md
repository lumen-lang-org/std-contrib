# markflow

A small **Markdown → HTML** renderer, written entirely in Lumen.

Unlike the FFI packages (`quickjs`, `sqlite`), markflow is **pure Lumen** — no C
shim, no native library, no `// @wasm-link`, nothing to install. Import it by URL
and it compiles straight to a native binary or to wasm.

## Use

```ts
import { render } from "https://lumen-lang.org/package/std-contrib/markflow/markflow.ts";

console.log(render("# Title\n\nSome **bold**, *italic*, `code`, and a [link](https://x.io).\n\n- one\n- two"));
```

```sh
lumen compile app.ts && ./app      # native
lumen compile --wasm app.ts        # wasm (e.g. the playground)
```

## API

| API | Meaning |
| --- | --- |
| `render(md: string): string` | render a Markdown document to an HTML fragment |

## Supported syntax

A practical subset of CommonMark:

- ATX headings `#` … `######`
- paragraphs
- inline `**bold**`, `*italic*`, `` `code` ``, `[text](url)`
- unordered lists (`-` / `*`)
- blockquotes (`>`)
- fenced code blocks (```` ``` ````)
- horizontal rules (`---`)

HTML metacharacters (`& < > "`) are escaped. Multi-row tables, ordered lists,
nested lists, and reference links are future additions.

## Performance

markflow is built around Lumen's string model: it flushes inline text in runs
(one concatenation per token, not per character) and fast-paths text that needs
no escaping. In the playground (wasm) it renders a typical document **faster than
the popular JavaScript Markdown libraries** (`markdown-it`, `marked`). For
absolute throughput on a hot path, a C renderer linked via `// @wasm-link`
(see the `quickjs`/`sqlite` packages for the pattern) is faster still.

# markdown

A small **Markdown → HTML** renderer, written entirely in Lumen.

Unlike the FFI packages (`quickjs`, `sqlite`), markdown is **pure Lumen** — no C
shim, no native library, nothing to install. Import it by URL and use it.

## Use

```ts
import { render } from "https://lumen-lang.org/package/std-contrib/markdown/markdown.ts";

console.log(render("# Title\n\nSome **bold**, *italic*, `code`, and a [link](https://x.io).\n\n- one\n- two"));
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

markdown is fast. Rendering a typical ~3 KB document in a tight loop — renders
per second, higher is better:

| Renderer                    | renders/sec |
|-----------------------------|------------:|
| **markdown** (this package) |   **6,775** |
| markdown-it                 |       2,020 |
| marked                      |       1,064 |

About **3.4× faster than markdown-it** and **6.4× faster than marked** on the
same document.

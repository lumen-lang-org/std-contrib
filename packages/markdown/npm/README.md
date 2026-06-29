# @lumen-org/markdown

Fast Markdown → HTML renderer, written in [Lumen](https://lumen-lang.org) and
compiled to WebAssembly. **Zero dependencies.**

```js
import { render } from "@lumen-org/markdown";
console.log(render("# Hello\n\nSome **bold** text."));
```

Faster than the popular pure-JS Markdown libraries (renders a typical document
~2.4× faster than markdown-it, ~5× faster than marked). Built from the pure-Lumen
[`markdown`](https://github.com/lumen-lang-org/std-contrib/tree/main/packages/markdown)
package via `lumen compile --reactor`.

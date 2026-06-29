// Reactor entry for the npm build: re-export markdown's render() so the wasm
// exposes a callable `render`. Rebuild with:
//   lumen compile --reactor reactor.ts   ->   markdown.wasm
import { render as mdRender } from "https://lumen-lang.org/package/std-contrib/markdown/markdown.ts";
export function render(md: string): string { return mdRender(md); }

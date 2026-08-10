# press

Templates for pages, in the shape EJS gave the world, minus the part a compiled
language cannot have.

```ts
import { view, render } from "../press/template.ts";

let v = view();
v.text.set("title", "Connected");
v.text.set("detail", "<img src=x onerror=alert(1)>");

render("<h1><%= title %> to <%= detail %></h1>", v);
// <h1>Connected to &lt;img src=x onerror=alert(1)&gt;</h1>
```

## Why it is not EJS

EJS embeds JavaScript and runs it: `<% if (user.admin) { %>` is real code handed
to `eval` at render time. Lumen compiles to a native binary and has no `eval`, so
that design is not available and pretending otherwise would produce a package
that could never render its own README example.

So the tags are EJS's, and what goes inside them is a name rather than an
expression. Everything a page needs — a value, a choice, a list — is here; a
computation is not, and belongs in the code that builds the view.

## The tags

| tag | what it does |
|---|---|
| `<%= name %>` | the value, HTML-escaped |
| `<%- name %>` | the value, raw |
| `<% if name %>…<% else %>…<% end %>` | the block when the value is not empty |
| `<% each list %>…<% end %>` | the block once per row |
| `<%= .field %>` | inside `each`, a field of the current row |
| `<%# … %>` | nothing |

Blocks nest. A name nothing set renders empty rather than failing, because a
half-rendered page is a better outage than a 500.

## Escaped by default

`<%=` escapes `&`, `<`, `>`, `"` and `'`. Raw output exists as `<%-` and has to be
asked for, which is the whole point: the page that made this package necessary
interpolated a connector's name straight into an `<h1>`, so a name carrying
markup was markup.

## The view

```ts
export type View = {
  text: Map<string, string>,
  lists: Map<string, Map<string, string>[]>,
};
```

Strings only. A number or a flag is turned into one by the caller, which keeps
the renderer free of formatting opinions — `900` and `true` reach the template as
text and land in the page as text.

## Checked before it renders

`templateProblem(src)` answers why a template will not work, or `""`:

```
a block is opened and never closed with <% end %>
an <% end %> closes a block that was never opened
unknown tag <% while %>: expected if, else, each or end
if needs a name: <% if something %>
a tag is opened with <% and never closed with %>
```

Run it once over a constant at startup rather than per request, and a broken
template is a boot failure rather than a page nobody can read.

## Testing

```sh
cd packages/press
lumen test template.test.ts    # 11
```

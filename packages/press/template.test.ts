import { View, view, render, escapeHtml, templateProblem } from "./template.ts";

function withText(pairs: string[][]): View {
  let v = view();
  let i: int = 0;
  while (i < pairs.length) {
    v.text.set(pairs[i][0], pairs[i][1]);
    i = i + 1;
  }
  return v;
}

test("text is escaped by default", () => {
  let v = withText([["title", "<script>alert(1)</script>"]]);
  let out = render("<h1><%= title %></h1>", v);
  expect(out == "<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>");
});

test("every character HTML cares about is escaped", () => {
  expect(escapeHtml("a&b<c>d\"e'f") == "a&amp;b&lt;c&gt;d&quot;e&#39;f");
});

test("raw output is opt-in", () => {
  let v = withText([["body", "<b>bold</b>"]]);
  expect(render("<p><%- body %></p>", v) == "<p><b>bold</b></p>");
});

test("a name nothing set renders empty rather than failing", () => {
  expect(render("[<%= missing %>]", view()) == "[]");
});

test("if renders its block only when the name has a value", () => {
  let yes = withText([["detail", "GitHub"]]);
  expect(render("<% if detail %>to <%= detail %><% end %>", yes) == "to GitHub");
  expect(render("<% if detail %>to <%= detail %><% end %>", view()) == "");
});

test("else is taken when the name is empty", () => {
  let v = withText([["error", "denied"]]);
  let t = "<% if error %>failed<% else %>worked<% end %>";
  expect(render(t, v) == "failed");
  expect(render(t, view()) == "worked");
});

test("each walks a list and . reads the row", () => {
  let v = view();
  let rows: Map<string, string>[] = [];
  let a = new Map<string, string>();
  a.set("name", "alpha");
  let b = new Map<string, string>();
  b.set("name", "b<eta");
  rows.push(a);
  rows.push(b);
  v.lists.set("items", rows);
  expect(render("<ul><% each items %><li><%= .name %></li><% end %></ul>", v)
    == "<ul><li>alpha</li><li>b&lt;eta</li></ul>");
});

test("each over a list nothing set renders nothing", () => {
  expect(render("<ul><% each items %><li>x</li><% end %></ul>", view()) == "<ul></ul>");
});

test("blocks nest", () => {
  let v = view();
  let rows: Map<string, string>[] = [];
  let a = new Map<string, string>();
  a.set("name", "alpha");
  a.set("flag", "yes");
  let b = new Map<string, string>();
  b.set("name", "beta");
  b.set("flag", "");
  rows.push(a);
  rows.push(b);
  v.lists.set("items", rows);
  expect(render("<% each items %><%= .name %><% if .flag %>!<% end %> <% end %>", v)
    == "alpha! beta ");
});

test("a comment renders nothing", () => {
  expect(render("a<%# never seen %>b", view()) == "ab");
});

test("an unclosed block is refused before it is rendered", () => {
  expect(templateProblem("<% if x %>no end") != "");
  expect(templateProblem("<% end %>") != "");
  expect(templateProblem("<% while x %><% end %>") != "");
  expect(templateProblem("<% if %><% end %>") != "");
  expect(templateProblem("<h1><%= title %></h1>") == "");
  expect(templateProblem("<% each rows %><%= .a %><% end %>") == "");
});

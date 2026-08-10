import { connectPageHtml } from "./page.ts";

test("a connected page names the connector", () => {
  let html = connectPageHtml(true, "GitHub");
  expect(html.indexOf("<h1>Connected to GitHub</h1>") >= 0);
  expect(html.indexOf("You can close this window.") >= 0);
  expect(html.indexOf("ok:true") >= 0);
});

test("a failed page shows the reason and no detail clause", () => {
  let html = connectPageHtml(false, "the provider refused");
  expect(html.indexOf("<h1>Not connected</h1>") >= 0);
  expect(html.indexOf("the provider refused") >= 0);
  expect(html.indexOf("ok:false") >= 0);
});

test("a detail carrying markup cannot reach the page as markup", () => {
  let html = connectPageHtml(true, "<img src=x onerror=alert(1)>");
  expect(html.indexOf("<img src=x") < 0);
  expect(html.indexOf("&lt;img src=x onerror=alert(1)&gt;") >= 0);
});

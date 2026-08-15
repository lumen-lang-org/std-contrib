import { View, view, render } from "../../../../press/template.ts";

export const CONNECT_PAGE = "<!doctype html><html><head><meta charset=\"utf-8\">"
  + "<title><%= title %></title><style>"
  + "body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;"
  + "height:100vh;background:#fafafa;color:#17171a}"
  + "div{text-align:center;max-width:32rem;padding:0 1.5rem}"
  + "h1{font-size:17px;margin:0 0 .35rem}p{margin:0;color:#6b6b70}"
  + "</style></head><body><div>"
  + "<h1><%= title %><% if detail %> to <%= detail %><% end %></h1>"
  + "<p><%= line %></p></div>"
  + "<script>try{if(window.opener){window.opener.postMessage("
  + "{joule:\"connector\",ok:<%- ok %>},window.location.origin)}}catch(e){}"
  + "setTimeout(function(){window.close()},<%- closeAfter %>)</script>"
  + "</body></html>";

export function connectPageHtml(worked: bool, detail: string): string {
  let v: View = view();
  v.text.set("title", worked ? "Connected" : "Not connected");
  v.text.set("line", worked ? "You can close this window." : detail);
  v.text.set("detail", worked ? detail : "");
  v.text.set("ok", worked ? "true" : "false");
  v.text.set("closeAfter", worked ? "900" : "4000");
  return render(CONNECT_PAGE, v);
}

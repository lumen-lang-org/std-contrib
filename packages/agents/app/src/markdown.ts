// The assistant's replies are markdown and nr-chatbot renders raw HTML — its
// declared `enableMarkdown` config exists in the type definitions and nowhere
// in the shipped component — so the console does the rendering itself.
//
// The order is the security property: the text is HTML-ESCAPED FIRST and the
// markdown pass below only ever introduces tags of its own making. Nothing
// the model writes can arrive as markup, because by the time this function
// sees it, every < is &lt;. That is also why this must never be handed raw
// text: give it anything unescaped and it will pass straight through.
//
// The dialect is deliberately small — headings, bold, italic, inline code,
// fenced code, lists, links — because a transcript is a conversation, not a
// document. Anything unrecognised stays visible as the characters the model
// typed, which is the honest failure.

const BLANK = /^\s*$/;

function inline(text: string): string {
  let out = text;
  // Inline code first, so nothing inside backticks is styled further. The
  // capture is already escaped text; it is wrapped, never rewritten.
  out = out.replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:rgba(125,125,125,.12);padding:.1em .35em;border-radius:4px">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  // Links: http(s) only, and the text is shown — a javascript: URL cannot
  // form because the scheme is anchored.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

/** Escaped markdown in, safe HTML out. */
export function renderMarkdown(escaped: string): string {
  const lines = escaped.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fenced = false;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      if (!fenced) {
        out.push('<pre style="background:rgba(125,125,125,.1);padding:10px 12px;border-radius:8px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap"><code>');
        fenced = true;
      } else {
        out.push("</code></pre>");
        fenced = false;
      }
      continue;
    }
    if (fenced) { out.push(line + "\n"); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const depth = heading[1].length;
      const size = depth <= 2 ? "1.05em" : "1em";
      out.push(`<div style="font-weight:600;font-size:${size};margin:.7em 0 .25em">${inline(heading[2])}</div>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== "ul") { closeList(); out.push('<ul style="margin:.25em 0;padding-left:1.4em">'); list = "ul"; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== "ol") { closeList(); out.push('<ol style="margin:.25em 0;padding-left:1.4em">'); list = "ol"; }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    if (BLANK.test(line)) { out.push('<div style="height:.5em"></div>'); continue; }
    out.push(`<div>${inline(line)}</div>`);
  }
  closeList();
  if (fenced) { out.push("</code></pre>"); }
  return out.join("");
}

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
  // Bare URLs become links too. The models this console runs cite sources as
  // naked addresses more often than as [text](url) — a citation nobody can
  // tap is not a citation. Only outside the anchors made above: the guard is
  // "not already preceded by =" or quote", which is what an href looks like
  // from here. Trailing punctuation stays outside the link — a URL at the
  // end of a sentence is not a URL ending in a period.
  out = out.replace(/(^|[^"'=\]\)])(https?:\/\/[^\s<>"']+?)([.,;:!?]?)(?=\s|$|<)/gm,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>$3');
  return out;
}

/** Escaped markdown in, safe HTML out. */
export function renderMarkdown(escaped: string): string {
  const lines = escaped.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  // How many backticks opened the fence we are inside, or 0 for "not in one".
  //
  // The count is the whole point, and getting it wrong loses text. A fence is
  // closed only by a run of AT LEAST as many backticks as opened it — so a
  // ```` block can quote a ``` block, which is exactly how a model shows a
  // reader what a save instruction looks like without issuing one. Treating
  // every line that starts with three backticks as a delimiter closed the
  // outer fence on the inner opener, ate that line, and rendered the quoted
  // payload as an ordinary paragraph: the console showed
  // `<script>fetch(...)</script>` as prose and silently dropped the
  // `path=/owned.html` beside it, which is the half of the quote that tells
  // the reader what they are looking at.
  let fence = 0;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const ticks = (line: string) => /^(`{3,})/.exec(line)?.[1].length ?? 0;

  for (const line of lines) {
    const run = ticks(line);
    // Inside a fence, only a bare run of at least the opening length closes it.
    // Anything else — including a shorter fence, or a longer one carrying an
    // info string — is content.
    if (fence > 0) {
      if (run >= fence && line.slice(run).trim() === "") {
        out.push("</code></pre>");
        fence = 0;
      } else {
        out.push(line + "\n");
      }
      continue;
    }
    if (run > 0) {
      closeList();
      out.push('<pre style="background:rgba(125,125,125,.1);padding:10px 12px;border-radius:8px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap"><code>');
      fence = run;
      continue;
    }

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
  // A fence the model never closed — a reply cut off mid-block — still has to
  // produce balanced markup.
  if (fence > 0) { out.push("</code></pre>"); }
  return out.join("");
}

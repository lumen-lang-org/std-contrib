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

// --- syntax highlighting ------------------------------------------------------
//
// Operates on text that is ALREADY HTML-ESCAPED, which is the constraint the
// whole thing is shaped by: by the time a fence's body reaches here every < is
// &lt; and every quote is &quot; or &#39;. So the string patterns match those
// entities rather than characters, and the tokeniser can never split one — it
// consumes `&quot;` and `&#39;` whole, and its word patterns match [A-Za-z_]
// runs, which an entity's `&`, `#` and `;` are not. That is what keeps the
// escaping intact through highlighting: nothing is unescaped and re-escaped,
// so there is no window where model text is raw.
//
// One alternation, one pass, ordered: comments and strings first, so a keyword
// inside either is part of the string and not a keyword. Anything unmatched is
// left exactly as it arrived.
//
// The palette is four custom properties with fallbacks that work on both
// themes. Inline styles because this lands inside nr-chatbot's shadow root
// where the console's stylesheet does not reach — the same reason the copy
// card next door is styled inline.

const KEYWORDS: Record<string, string> = {
  js: "import|export|from|default|const|let|var|function|return|if|else|for|while|class|extends|new|await|async|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this|super|switch|case|break|continue|do|in|of|delete|void|yield|static|get|set",
  ts: "import|export|from|default|const|let|var|function|return|if|else|for|while|class|extends|implements|interface|type|enum|new|await|async|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this|super|switch|case|break|continue|readonly|public|private|protected|as|satisfies",
  py: "import|from|as|def|class|return|if|elif|else|for|while|try|except|finally|raise|with|lambda|None|True|False|and|or|not|in|is|pass|break|continue|yield|global|nonlocal|assert|async|await",
  sh: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|echo|cd|set|unset|read|exit",
  json: "true|false|null",
  css: "important|from|to",
  html: "",
  rs: "fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|self|Self|where|as|ref|move|async|await|dyn|crate|true|false",
  go: "func|package|import|var|const|type|struct|interface|map|chan|go|defer|if|else|for|range|return|switch|case|default|nil|true|false",
};

/** Which keyword set a fence's info string asks for. Unknown languages get
 *  the JavaScript set, which is the closest thing to a lingua franca among the
 *  curly-brace languages a chat produces — and getting it wrong only means a
 *  word is not coloured, never that text is lost. */
function keywordsFor(lang: string): string {
  const l = lang.toLowerCase();
  const alias: Record<string, string> = {
    javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
    typescript: "ts", tsx: "ts",
    python: "py", py3: "py",
    bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh",
    rust: "rs", golang: "go", yaml: "json", yml: "json",
  };
  const key = alias[l] ?? l;
  return KEYWORDS[key] ?? KEYWORDS.js;
}

/** Escaped code in, escaped code with colour spans out. */
function highlight(escaped: string, lang: string): string {
  const words = keywordsFor(lang);
  const C = {
    comment: "var(--code-comment,#7a8a99)",
    str: "var(--code-string,#3f9a5d)",
    key: "var(--code-keyword,#a057c8)",
    num: "var(--code-number,#c07030)",
  };
  const span = (colour: string, body: string) => `<span style="color:${colour}">${body}</span>`;

  // Order is the correctness property, not a preference: a comment may contain
  // a quote and a string may contain //, so whichever is tried first owns the
  // rest of its run.
  const pattern = new RegExp(
    "(/\\*[\\s\\S]*?\\*/)"                       // /* block comment */
    + "|(//[^\\n]*)"                                   // // line comment
    + "|(#[^\\n]*)"                                    // # line comment
    + "|(&quot;(?:\\\\.|(?!&quot;)[\\s\\S])*?&quot;)"   // "double string"
    + "|(&#39;(?:\\\\.|(?!&#39;)[\\s\\S])*?&#39;)"      // 'single string'
    + "|(`(?:\\\\.|[^`])*?`)"                        // `template string`
    + "|\\b(\\d[\\d_.]*)\\b"                     // 1234
    + (words === "" ? "" : "|\\b(" + words + ")\\b"), // keywords
    "g");

  return escaped.replace(pattern, (m, block, line, hash, dq, sq, tick, num, kw) => {
    if (block !== undefined || line !== undefined || hash !== undefined) return span(C.comment, m);
    if (dq !== undefined || sq !== undefined || tick !== undefined) return span(C.str, m);
    if (num !== undefined) return span(C.num, m);
    if (kw !== undefined) return span(C.key, m);
    return m;
  });
}


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
    '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--md-link,#2563eb)">$1</a>');
  // Bare URLs become links too. The models this console runs cite sources as
  // naked addresses more often than as [text](url) — a citation nobody can
  // tap is not a citation. Only outside the anchors made above: the guard is
  // "not already preceded by =" or quote", which is what an href looks like
  // from here. Trailing punctuation stays outside the link — a URL at the
  // end of a sentence is not a URL ending in a period.
  out = out.replace(/(^|[^"'=\]\)])(https?:\/\/[^\s<>"']+?)([.,;:!?]?)(?=\s|$|<)/gm,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--md-link,#2563eb)">$2</a>$3');
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
  let fenceLang = "";
  let fenceLines: string[] = [];
  // The opener's own indentation, removed from every content line — the
  // CommonMark rule, and what makes copying a block out of a numbered list
  // hand you the command, not the command wearing the list's margin.
  let fenceIndent = 0;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  // Leading whitespace allowed, which is the fix a screenshot forced: a model
  // answering inside a numbered list indents the fence under the item, the
  // old ^-anchored match missed it, and the block rendered as prose — with
  // its backticks visible and the URL inside autolinked, precisely the two
  // things a code block exists to prevent.
  const opener = (line: string) => /^(\s*)(`{3,})\s*(\S*)\s*$/.exec(line);
  const anyRun = (line: string) => /^\s*(`{3,})/.exec(line)?.[1].length ?? 0;

  /** The finished block, as the correction card's shape: a bordered box, an
   *  eyebrow naming the language, and the same data-copy-card button the
   *  console's delegated listener already serves — one copy mechanism, not
   *  two. The code is emitted twice like the card's body is, and for the
   *  card's reason: once for display, once into the attribute so the button
   *  hands the clipboard the exact text, not the browser's extraction. */
  const emitBlock = () => {
    const code = fenceLines.join("\n");
    const label = fenceLang === "" ? "code" : fenceLang.slice(0, 16);
    const border = "var(--nuraly-border-color,rgba(128,128,128,.25))";
    out.push(
      `<div style="margin:10px 0;border:1px solid ${border};border-radius:12px;overflow:hidden">`
      + `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid ${border};background:rgba(125,125,125,.07)">`
      + `<span style="flex:1;min-width:0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">${label}</span>`
      + `<button type="button" data-copy-card="${code}" style="display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;background:none;border:1px solid ${border};color:inherit;opacity:.8">Copy</button>`
      + `</div>`
      + `<pre style="margin:0;background:rgba(125,125,125,.08);padding:10px 12px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap"><code>${highlight(code, fenceLang)}</code></pre>`
      + `</div>`);
    fence = 0;
    fenceLang = "";
    fenceLines = [];
  };

  for (const line of lines) {
    // Inside a fence, only a bare run of at least the opening length closes it.
    // Anything else — including a shorter fence, or a longer one carrying an
    // info string — is content.
    if (fence > 0) {
      const run = anyRun(line);
      if (run >= fence && line.replace(/^\s*`+/, "").trim() === "") {
        emitBlock();
      } else {
        let clipped = line;
        let strip = 0;
        while (strip < fenceIndent && strip < clipped.length && clipped[strip] === " ") { strip += 1; }
        fenceLines.push(clipped.slice(strip));
      }
      continue;
    }
    const open = opener(line);
    if (open) {
      closeList();
      fenceIndent = open[1].length;
      fence = open[2].length;
      fenceLang = open[3];
      fenceLines = [];
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
  // A fence the model never closed — a reply cut off mid-block — still gets
  // the full block, copy button included: mid-stream every block is briefly
  // unclosed, and the button appearing only at the closing fence would be a
  // control that pops in at the end of the very element it belongs to.
  if (fence > 0) { emitBlock(); }
  return out.join("");
}

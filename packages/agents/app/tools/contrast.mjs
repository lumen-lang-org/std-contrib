// Contrast for the token pairs that actually appear on screen.
//
// The console's dark palette was reverted once before, and the reason was not
// that it looked wrong in a screenshot: it was that individual pairs — ink on
// a panel, a muted label on a sunken fill — fell under 4.5:1 in places nobody
// had looked at. Eyeballing a dark theme is exactly the wrong instrument,
// because a low-contrast pair looks *calm* until you try to read it.
//
// So the pairs are listed, not sampled, and the list is the claim: these are
// the combinations the console puts on screen. Adding a token means adding its
// pairs here, or the check silently keeps passing.
//
//   node tools/contrast.mjs
//
// WCAG 2.1: 4.5:1 for body text, 3:1 for large text (>=18.66px bold or 24px)
// and for the boundary of a UI component. A border is neither — it is
// decoration when it separates two of your own surfaces — so borders are
// reported but not enforced.

/** sRGB hex or rgba() over a known backdrop -> {r,g,b} 0-255. */
function parse(colour, over) {
  const hex = colour.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m = colour.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!m) throw new Error("cannot parse colour: " + colour);
  const [r, g, b, a = 1] = m[1].split(",").map((s) => parseFloat(s));
  if (a === 1) return { r, g, b };
  if (!over) throw new Error("translucent colour needs a backdrop: " + colour);
  // Composite, because a token at 45% opacity is not a colour until it is on
  // something. This is the step that makes "black at an opacity" checkable.
  return {
    r: r * a + over.r * (1 - a),
    g: g * a + over.g * (1 - a),
    b: b * a + over.b * (1 - a),
  };
}

function luminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(fg, bg, base) {
  const back = parse(bg, base);
  const front = parse(fg, back);
  const a = luminance(front), b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The two palettes, transcribed from head.html. Kept here rather than parsed
// out of it: a parser that silently matched nothing would report a clean run
// against no data at all, which is the failure mode this file exists to avoid.
const LIGHT = {
  bg: "#FFFFFF", bgRail: "#FAFAFA", bgCard: "#FFFFFF", input: "#FFFFFF",
  sunken: "rgba(0,0,0,.045)", user: "rgba(0,0,0,.045)", fill1: "rgba(0,0,0,.03)",
  fg: "rgba(0,0,0,.9)", muted: "rgba(0,0,0,.45)", faint: "rgba(0,0,0,.3)",
  border: "rgba(0,0,0,.09)", accent: "#17171A", accentFg: "#FFFFFF",
  focus: "#2563EB", danger: "#B3261E", ok: "#157F4D",
};

const DARK = {
  bg: "#181818", bgRail: "#141414", bgCard: "#1F1F1F", input: "#1F1F1F",
  sunken: "rgba(255,255,255,.07)", user: "rgba(255,255,255,.07)",
  fill1: "rgba(255,255,255,.04)",
  fg: "rgba(255,255,255,.92)", muted: "rgba(255,255,255,.60)",
  faint: "rgba(255,255,255,.42)",
  border: "rgba(255,255,255,.12)", accent: "#EDEDED", accentFg: "#17171A",
  focus: "#7AA7FF", danger: "#FF8A80", ok: "#5DD39E",
};

/** [ink, surface, minimum, what it is] — surfaces a token is really drawn on. */
const PAIRS = (p) => [
  [p.fg, p.bg, 4.5, "body text on the sheet"],
  [p.fg, p.bgRail, 4.5, "body text on the rail"],
  [p.fg, p.bgCard, 4.5, "body text on a card"],
  [p.fg, p.input, 4.5, "what you type, in the composer"],
  [p.fg, p.sunken, 4.5, "text on a hover wash"],
  [p.fg, p.user, 4.5, "your own turn in the transcript"],
  [p.muted, p.bg, 4.5, "secondary label on the sheet"],
  [p.muted, p.bgRail, 4.5, "secondary label on the rail"],
  [p.muted, p.bgCard, 4.5, "card meta line"],
  [p.faint, p.bg, 3.0, "placeholder in the composer"],
  [p.faint, p.input, 3.0, "placeholder on the composer surface"],
  [p.accentFg, p.accent, 4.5, "label on a primary button"],
  [p.danger, p.bg, 4.5, "an error message"],
  [p.danger, p.bgCard, 4.5, "an error inside a panel"],
  [p.ok, p.bg, 4.5, "a success message"],
  [p.ok, p.bgRail, 4.5, "a success message on the rail"],
  [p.focus, p.bg, 3.0, "the focus ring on the sheet"],
  [p.focus, p.bgRail, 3.0, "the focus ring on the rail"],
];

let failed = 0;
for (const [name, palette] of [["light", LIGHT], ["dark", DARK]]) {
  console.log(`\n${name}`);
  for (const [fg, bg, min, what] of PAIRS(palette)) {
    const base = parse(palette.bg);
    const r = ratio(fg, bg, base);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.toFixed(2)}:1 (needs ${min}) — ${what}`);
  }
  // Reported, not enforced: a hairline between two of your own surfaces is
  // decoration, and holding it to 3:1 would make it a rule rather than a hint.
  const b = ratio(palette.border, palette.bg, parse(palette.bg));
  console.log(`  --   ${b.toFixed(2)}:1 — border against the sheet (not enforced)`);
}

if (failed > 0) {
  console.error(`\n${failed} pair${failed === 1 ? "" : "s"} below the minimum.`);
  process.exit(1);
}
console.log("\nevery enforced pair passes");

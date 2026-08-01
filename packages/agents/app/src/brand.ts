// The product's name, in exactly one place.
//
// Joule: the SI unit of work done — the same register as Lumen, the unit of
// light, which is the language this whole stack is built in. The language
// gives the light; these agents do the work.
//
// Everything that shows the name imports it from here: the sidebar's brand
// line, the home screen's welcome mark, the signed-out avatar, the browser
// tab. Nothing else may spell it out — the previous name survived a rebrand
// attempt in four hardcoded strings, which is how a product ends up greeting
// people under two names at once. If a deployment ever needs its own name
// (EDITIONS.md's operator will), this is the seam where that config lands;
// until someone actually asks, one constant is the entire mechanism.
export const BRAND = "Joule";

// The wordmark is the name plus the period — the period is deliberate, it is
// the brand's whole punctuation. Where markup styles the dot separately (the
// sidebar), use BRAND and render the dot in its own span; where the name is
// handed over as one string (the chatbot's welcome mark), use this.
export const WORDMARK = BRAND + ".";

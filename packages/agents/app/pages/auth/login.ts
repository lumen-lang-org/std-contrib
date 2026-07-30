// /auth/login — the address src/api.ts has always sent a 401 to.
//
// `LOGIN` in src/api.ts is this path and was this path before phase 4: a
// deployment fronted by an authenticating proxy serves its own login here, a
// community deployment never answers 401 so nobody ever arrives, and under
// `AUTH=builtin` this file is what is finally at the other end. That is the
// seam paying off, and it is why src/api.ts needed no edit.
//
// The page is the card. See pages/auth/_form.ts for why the base class rather
// than a nested element, and for the LumenUI bundle note.

import { AuthCard } from "./_form.js";

export class PageAuthLogin extends AuthCard {
  mode: "login" | "signup" = "login";
}

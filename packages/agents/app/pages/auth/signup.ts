// /auth/signup — how the first account on a `builtin` box comes to exist.
//
// There is no bootstrap script and no seeded admin, on purpose: a default
// account is a default password, and the community edition has spent this
// whole migration not having one. So the first person to reach a fresh
// `AUTH=builtin` console creates their own account, and `AUTH_ALLOW_SIGNUP=0`
// closes the door behind them once the team is in (server/auth-builtin.ts).
//
// Who gets the admin role is a separate question with a separate answer —
// `AUTH_BUILTIN_ADMINS`, an email list, also in server/auth-builtin.ts — because
// "first to sign up wins" is a race on a box that is reachable before anyone
// has signed up.

import { AuthCard } from "./_form.js";

export class PageAuthSignup extends AuthCard {
  mode: "login" | "signup" = "signup";
}

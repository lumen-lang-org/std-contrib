export function callbackUri(): string {
  let origin = (process.env("AGENTS_PUBLIC_ORIGIN") ?? "").trim();
  if (origin == "") {
    return "";
  }
  while (origin.endsWith("/")) {
    origin = origin.slice(0, origin.length - 1);
  }
  return origin + "/api/connect/callback";
}

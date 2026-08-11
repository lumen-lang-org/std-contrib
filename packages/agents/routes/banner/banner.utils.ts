import { utf8Length } from "../../artifacts.ts";

export const BANNER_MAX: int = 500;

export function bannerFault(text: string): string {
  if (utf8Length(text) > BANNER_MAX) {
    return "a banner is at most 500 bytes — it is a sentence, not a page";
  }
  return "";
}

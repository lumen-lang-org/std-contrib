import { owningTag } from "../../../owner.ts";

export function wantedOwner(tags: string[], asked: string): string {
  if (asked == "") {
    return owningTag(tags);
  }
  return asked;
}

import { ScriptImageBody } from "./dtos/script-image-body.dto.ts";

export function scriptImageFault(row: ScriptImageBody): string {
  if (row.label.trim() == "") {
    return "an image needs a label to pick it by";
  }
  if (row.image.trim() == "") {
    return "an image needs a reference, such as agents-runtime:1";
  }
  let i: int = 0;
  while (i < row.image.length) {
    let c = row.image.charCodeAt(i);
    if (c <= 32 || c == 34 || c == 39 || c == 96 || c == 36 || c == 59) {
      return "an image reference is one word: \"" + row.image + "\" carries a space or a shell character";
    }
    i = i + 1;
  }
  return "";
}

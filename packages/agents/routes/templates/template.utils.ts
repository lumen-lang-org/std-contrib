import { officeRenderExt } from "../../office-render.ts";
import { TemplateFileBody } from "./dtos/template-file-body.dto.ts";

export function renderableFileIndex(files: TemplateFileBody[]): int {
  let i: int = 0;
  while (i < files.length) {
    if (officeRenderExt(files[i].path) != "") {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

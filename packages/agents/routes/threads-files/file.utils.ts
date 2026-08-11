import { WorkspaceFileRow } from "../../workspace.ts";
import { FileContent } from "./dtos/file-content.dto.ts";
import { FileView } from "./dtos/file-view.dto.ts";

export const UPLOAD_BODY_HELP = "a body is required: {\"name\":\"notes.md\",\"content\":\"...\"}";

export const PROMOTE_BODY_HELP = "a body is required: {\"scope\":\"/specs\",\"modelId\":\"e1\"}";

export function fileView(row: WorkspaceFileRow): FileView {
  let view: FileView = {
    name: row.fileName,
    mime: row.mime,
    origin: row.origin,
    bytes: row.body.length,
    documentId: row.documentId,
  };
  return view;
}

export function fileContent(row: WorkspaceFileRow): FileContent {
  let view: FileContent = {
    name: row.fileName,
    mime: row.mime,
    origin: row.origin,
    content: row.body,
  };
  return view;
}

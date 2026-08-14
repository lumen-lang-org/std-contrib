import { safeIdentifier } from "../../../plume/plume.ts";
import { DocumentFileRow } from "../../document-files.ts";
import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";
import { SourceListing } from "../../knowledge.ts";
import { DocumentFileView } from "./dtos/document-file-view.dto.ts";
import { DocumentSummary } from "./dtos/document-summary.dto.ts";

export function sourceFault(source: string, body: string): string {
  if (source.trim() == "") {
    return "a document needs a source to be filed under";
  }
  if (!safeIdentifier(source)) {
    return "a source must be a plain name: letters, digits, _ and -";
  }
  if (body.trim() == "") {
    return "an empty document has nothing to retrieve";
  }
  return "";
}

export function firstText(said: string, fallback: string): string {
  let text = said.trim();
  if (text == "") {
    return fallback;
  }
  return text;
}

export function decodedSize(base64: string): int {
  let text = base64.trim();
  if (text.length == 0) {
    return 0;
  }
  let padding: int = 0;
  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }
  let whole = (text.length / 4) * 3;
  return whole - padding;
}

export function queuedSummary(job: IndexJobRow, hasFile: bool): DocumentSummary {
  let out: DocumentSummary = {
    source: job.source,
    scope: job.scope,
    chunks: 0,
    bytes: 0,
    status: job.status,
    error: job.error,
    hasFile: hasFile,
  };
  return out;
}

export function indexedSummary(row: SourceListing, hasFile: bool): DocumentSummary {
  let out: DocumentSummary = {
    source: row.source,
    scope: row.scope,
    chunks: row.chunks,
    bytes: row.bytes,
    status: "indexed",
    error: "",
    hasFile: hasFile,
  };
  return out;
}

export function documentFileViewOf(row: DocumentFileRow): DocumentFileView {
  let out: DocumentFileView = {
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    contentBase64: row.bytes,
  };
  return out;
}

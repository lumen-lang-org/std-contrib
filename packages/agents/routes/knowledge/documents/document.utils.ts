import { SourceListing, normalScope, ownerStem, plainSource } from "../../../knowledge.ts";
import { IndexJobRow } from "../jobs/entities/index-job.entity.ts";
import { DocumentFileView } from "./dtos/document-file-view.dto.ts";
import { DocumentSummary } from "./dtos/document-summary.dto.ts";

export const FILE_BASE64_MAX: int = 24 * 1024 * 1024;

export type DocumentFileRow = {
  id: string,
  owner: string,
  source: string,
  scope: string,
  filename: string,
  mime: string,
  bytes: string,
  size: int,
  createdAt: string,
};

/** Keyed with the owner so two people may keep a file of the same name in the
 *  same scope. Empty for the deployment's own, which keeps every existing key. */
export function documentFileId(owner: string, scope: string, source: string): string {
  return ownerStem(owner) + normalScope(scope) + "/" + source;
}

export function emptyDocumentFile(): DocumentFileRow {
  let none: DocumentFileRow = {
    id: "",
    owner: "",
    source: "",
    scope: "",
    filename: "",
    mime: "",
    bytes: "",
    size: 0,
    createdAt: "",
  };
  return none;
}

export function holdsSource(names: string[], source: string): bool {
  let i: int = 0;
  while (i < names.length) {
    if (names[i] == source) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export function sourceFault(source: string, body: string): string {
  if (source.trim() == "") {
    return "a document needs a source to be filed under";
  }
  if (!plainSource(source)) {
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

/* A file whose bytes are held and whose words are not in the corpus: a scan,
 * a picture, a format nothing here reads, or one uploaded before the reader
 * existed. It is listed because it is there. Listing the corpus alone made
 * such a file vanish from the page the moment it was uploaded, which read as
 * a failed upload rather than as a file that cannot be searched. */
export function keptSummary(source: string, scope: string): DocumentSummary {
  let out: DocumentSummary = {
    source: source,
    scope: normalScope(scope),
    chunks: 0,
    bytes: 0,
    status: "kept",
    error: "",
    hasFile: true,
  };
  return out;
}

export function listedAlready(shown: DocumentSummary[], source: string): bool {
  let i: int = 0;
  while (i < shown.length) {
    if (shown[i].source == source) {
      return true;
    }
    i = i + 1;
  }
  return false;
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

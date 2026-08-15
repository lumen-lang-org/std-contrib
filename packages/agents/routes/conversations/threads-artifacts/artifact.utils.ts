import { ArtifactRow, ArtifactVersionRow, TURN_SEQ_NONE, TurnArtifact } from "../../../artifacts.ts";
import { OfficeRendered } from "../../../office-render.ts";
import { ArtifactPdfView } from "./dtos/artifact-pdf-view.dto.ts";
import { ArtifactVersionView } from "./dtos/artifact-version-view.dto.ts";
import { ArtifactView } from "./dtos/artifact-view.dto.ts";
import { TurnArtifactView } from "./dtos/turn-artifact-view.dto.ts";

export const TEMPLATE_BODY_HELP = "a body is required: {\"templateId\":\"tpl-...\"}";

export const ARTIFACT_BODY_HELP = "a body is required: {\"path\":\"/report.html\",\"title\":\"Q3\",\"content\":\"...\",\"note\":\"\"}";

export function slotFromPath(slot: string): int {
  return parseInt(slot) ?? -1;
}

export function versionFromPath(asked: string): int {
  return parseInt(asked) ?? 0;
}

export function turnFromQuery(turn: string): int {
  return parseInt(turn) ?? TURN_SEQ_NONE;
}

export function noArtifact(): ArtifactRow {
  let absent: ArtifactRow = {
    id: "", threadId: "", slot: -1, path: "", title: "", kind: "", mime: "",
    currentVersion: 0, previewToken: "", createdAt: "", updatedAt: "",
  };
  return absent;
}

export function artifactView(artifact: ArtifactRow): ArtifactView {
  let view: ArtifactView = {
    slot: artifact.slot,
    path: artifact.path,
    title: artifact.title,
    kind: artifact.kind,
    mime: artifact.mime,
    version: artifact.currentVersion,
    previewToken: artifact.previewToken,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
  return view;
}

export function turnArtifactView(turned: TurnArtifact): TurnArtifactView {
  let view: TurnArtifactView = {
    turnSeq: turned.turnSeq,
    slot: turned.slot,
    path: turned.path,
    title: turned.title,
    kind: turned.kind,
    version: turned.version,
  };
  return view;
}

export function artifactVersionView(artifact: ArtifactRow, row: ArtifactVersionRow): ArtifactVersionView {
  let view: ArtifactVersionView = {
    slot: artifact.slot,
    path: artifact.path,
    version: row.version,
    bytes: row.bytes,
    origin: row.origin,
    turnSeq: row.turnSeq,
    note: row.note,
    createdAt: row.createdAt,
    content: row.body,
  };
  return view;
}

export function artifactPdfView(artifact: ArtifactRow, version: int, made: OfficeRendered): ArtifactPdfView {
  let view: ArtifactPdfView = {
    slot: artifact.slot,
    path: artifact.path,
    version: version,
    cached: made.cached,
    pdf: made.body,
  };
  return view;
}

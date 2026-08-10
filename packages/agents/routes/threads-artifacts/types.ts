export type ArtifactPost = { path: string, title: string, content: string, note: string };

export type ArtifactView = {
  slot: int,
  path: string,
  title: string,
  kind: string,
  mime: string,
  version: int,
  previewToken: string,
  createdAt: string,
  updatedAt: string,
};

export type ArtifactCreated = {
  slot: int,
  path: string,
  version: int,
  previewToken: string,
};

export type TemplateStarted = {
  template: string,
  skillName: string,
  wrote: string[],
  refused: string[],
};

export type TurnArtifactView = {
  turnSeq: int,
  slot: int,
  path: string,
  title: string,
  kind: string,
  version: int,
};

export type ArtifactVersionView = {
  slot: int,
  path: string,
  version: int,
  bytes: int,
  origin: string,
  turnSeq: int,
  note: string,
  createdAt: string,
  content: string,
};

export type ArtifactPdfView = {
  slot: int,
  path: string,
  version: int,
  cached: bool,
  pdf: string,
};

export type ArtifactRotated = {
  slot: int,
  previewToken: string,
  replaced: int,
};

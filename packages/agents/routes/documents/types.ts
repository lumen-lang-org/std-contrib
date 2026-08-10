export type DocumentUpload = { source: string, scope: string, body: string };

export type DocumentSummary = {
  source: string,
  scope: string,
  chunks: int,
  bytes: int,
  status: string,
  error: string,
  hasFile: bool,
};

export type DocumentQueued = {
  job: string,
  source: string,
  scope: string,
  status: string,
};

export type DocumentStored = {
  stored: bool,
};

export type DocumentFileView = {
  filename: string,
  mime: string,
  size: int,
  contentBase64: string,
};

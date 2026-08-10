export type FileUpload = { name: string, content: string };

export type FilePromote = { scope: string, modelId: string };

export type FilePull = { name: string, documentId: string };

export type FileView = {
  name: string,
  mime: string,
  origin: string,
  bytes: int,
  documentId: string,
};

export type FileUploaded = { name: string, bytes: int };

export type FileContent = {
  name: string,
  mime: string,
  origin: string,
  content: string,
};

export type FilePulled = { name: string, documentId: string };

export type FilePromoted = { name: string, scope: string, chunks: int };

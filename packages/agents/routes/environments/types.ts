export type EnvCreateAsk = {
  name?: string,
  image?: string,
  dockerfile?: string,
  templateId?: string,
};

export type EnvCatalogItem = {
  id: string,
  label: string,
  summary: string,
  mine: bool,
  present: bool,
};

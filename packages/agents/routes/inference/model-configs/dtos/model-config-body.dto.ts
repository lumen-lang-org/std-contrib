/** A model config as this route reads and writes it.
 *
 *  The same columns the entity carries. Read back through the repository's
 *  listing the row arrives with its model joined on; the extra member is
 *  ignored on the way in, which is what keeps a read-modify-write from
 *  storing the join. */
export type ModelConfigBody = {
  id: string,
  modelId: string,
  temperature: number,
  maxTokens: int,
  topP: number,
  extra: string,
  thinking: string,
  label: string,
  selectable: bool,
  rank: int,
};

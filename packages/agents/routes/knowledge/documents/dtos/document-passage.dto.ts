/** One passage a question pulled back, in the order the corpus ranked it.
 *
 *  `distance` is what the vector store measured, carried through rather than
 *  turned into a score: smaller is nearer, and the number belongs to whoever
 *  is comparing two answers. */
export type DocumentPassage = {
  id: string,
  source: string,
  scope: string,
  body: string,
  distance: number,
};

export type DocumentAnswer = {
  question: string,
  scope: string,
  model: string,
  found: DocumentPassage[],
};

// A tiny knowledge base for the support agent, plus a keyword-RAG lookup over it.
// Everything here is offline: no API key, no network — retrieval uses the
// package's keyword retriever, so the whole example runs with no setup.

import { splitDocuments, keywordRetrieve, formatContext } from "../../ai.ts";

// The "product docs" the agent can search. In a real app this would be loaded
// from files; here it is inline so the example runs immediately.
export function knowledgeText(): string {
  return "Lumen compiles TypeScript syntax straight to a native binary. There is no runtime, no garbage collector, and no interpreter in the output.\n\n"
    + "To install Lumen, run the install script from lumen-lang.org. Windows users download the zip from the releases page.\n\n"
    + "A Lumen package is just a URL. An import from an https URL is fetched over HTTPS and inlined at compile time, so there is no package manager and no lockfile.\n\n"
    + "Lumen talks to C libraries through a foreign function interface: declare a function and link the library, and scalars and strings marshal across the boundary.\n\n"
    + "The Lumen playground compiles submitted source to WebAssembly on a server and runs the resulting module in the browser sandbox.";
}

// Return the best-matching passage for a question as a cited context block.
// This is the body of the agent's "search_docs" tool.
export function lookupDocs(question: string): string {
  let docs = splitDocuments(knowledgeText(), "docs", 400, 40);
  let hits = keywordRetrieve(docs, question, 1);
  if (hits.length == 0) {
    return "No matching documentation was found.";
  }
  return formatContext(hits);
}

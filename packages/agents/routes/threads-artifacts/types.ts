// The shapes the threads-artifacts routes read and write.

// Every field is required, `note` included — JSON.parse refuses a body missing
// one, so "no note" is spelled "note":"" rather than left out.
export type ArtifactPost = { path: string, title: string, content: string, note: string };

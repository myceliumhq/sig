// The agent-facing contract the search command / signal_search_messages tool
// merges into its lexical results. @myceliumhq/index's own SemanticMatch uses a
// string sourceId; this app's message ids are already strings (`source:ts`,
// the SQLite UNIQUE(source, ts) natural key), so the mapping is 1:1 -- unlike
// ppl, which adapts number document ids at the boundary.
export type SemanticMatch = {
  messageId: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};

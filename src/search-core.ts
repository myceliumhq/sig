import { reciprocalRankFusion } from "@myceliumhq/index";
import type { MessageRow, MessageStore } from "./ingest/store.js";
import type { SemanticSearchHandle } from "./semantic/handle.js";

// Shared hybrid (lexical + semantic) message search, consumed by both the CLI
// `sig search` command and the MCP signal_search_messages tool -- same fusion,
// same shaped rows, so the two surfaces can't drift. Mirrors ppl's search
// design (RRF over lexical + a semanticd sidecar), applied to message bodies as
// the indexed content unit.

export interface SearchRow {
  id: string;
  source: string;
  direction: string | null;
  sender: string | null;
  sender_name: string | null;
  group_id: string | null;
  ts: number;
  time: string;
  body: string;
  // Only set when a semantic pass actually ran. "semantic" (no lexical hit at
  // all) is the real no-match proxy an agent should key on -- cosine-similarity
  // scores are not a calibrated relevance measure (see AGENTS.md / ppl).
  match_source?: "lexical" | "semantic" | "both";
  semantic_score?: number;
  content_snippet?: string;
}

export interface SearchResult {
  rows: SearchRow[];
  truncated: boolean;
  usedSemantic: boolean;
  lexicalCount: number;
}

function shape(
  row: MessageRow,
): Omit<SearchRow, "match_source" | "semantic_score" | "content_snippet"> {
  return {
    id: `${row.source}:${row.ts}`,
    source: row.source,
    direction: row.direction,
    sender: row.sender,
    sender_name: row.senderName,
    group_id: row.groupId,
    ts: row.ts,
    time: new Date(row.ts).toISOString(),
    body: row.body,
  };
}

export async function hybridSearch(
  store: MessageStore,
  semantic: SemanticSearchHandle,
  query: string,
  limit: number,
): Promise<SearchResult> {
  // Over-fetch lexical so fusion has a real pool to rank; cap the returned set
  // at `limit`.
  const lexicalHits = store.searchLexical(query, Math.max(limit * 3, limit));
  const rowById = new Map<string, MessageRow>();
  const lexicalIds: string[] = [];
  for (const hit of lexicalHits) {
    lexicalIds.push(hit.id);
    rowById.set(hit.id, hit.row);
  }

  const usedSemantic = semantic.available && query.length > 0;
  let semanticIds: string[] = [];
  const semanticScoreById = new Map<string, number>();
  const snippetById = new Map<string, string>();

  if (usedSemantic) {
    const matches = await semantic.search(query, limit);
    semanticIds = matches.map((m) => m.messageId);
    for (const m of matches) {
      semanticScoreById.set(m.messageId, m.score);
      if (m.snippet) snippetById.set(m.messageId, m.snippet);
    }
    // Resolve any semantic-only ids the lexical pass didn't surface.
    const missing = semanticIds.filter((id) => !rowById.has(id));
    if (missing.length > 0) {
      for (const [id, row] of store.getByIds(missing)) rowById.set(id, row);
    }
  }

  const fused =
    usedSemantic && semanticIds.length > 0
      ? reciprocalRankFusion([lexicalIds, semanticIds]).map((h) => h.id)
      : lexicalIds;

  const finalIds = fused.filter((id) => rowById.has(id)).slice(0, limit);
  const truncated = fused.filter((id) => rowById.has(id)).length > finalIds.length;

  const lexicalSet = new Set(lexicalIds);
  const semanticSet = new Set(semanticIds);

  const rows: SearchRow[] = finalIds.map((id) => {
    const row = rowById.get(id) as MessageRow;
    const base = shape(row);
    const inLexical = lexicalSet.has(id);
    const inSemantic = semanticSet.has(id);
    return {
      ...base,
      ...(usedSemantic
        ? {
            match_source: (inLexical && inSemantic
              ? "both"
              : inLexical
                ? "lexical"
                : "semantic") as SearchRow["match_source"],
            ...(semanticScoreById.has(id) ? { semantic_score: semanticScoreById.get(id) } : {}),
            ...(snippetById.has(id) ? { content_snippet: snippetById.get(id) } : {}),
          }
        : {}),
    };
  });

  return { rows, truncated, usedSemantic, lexicalCount: lexicalIds.length };
}

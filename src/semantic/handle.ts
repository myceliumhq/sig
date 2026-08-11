import { createSemanticdClient } from "@myceliumhq/semanticd";
import type { SemanticMatch } from "./types.js";

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  // Base URL of a sig-semanticd sidecar (its own SEMANTICD_PORT) running
  // @myceliumhq/sig/semantic-adapter against the SAME SQLite message store this
  // app's ingestion daemon writes.
  semanticdUrl?: string;
};

export type Logger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

export type SemanticSearchHandle = {
  // False whenever semantic search isn't configured/reachable. `search` still
  // exists and is always safe to call -- it just resolves to `[]`, so callers
  // fail open to lexical-only.
  available: boolean;
  search: (searchTerm: string | undefined, limit: number) => Promise<SemanticMatch[]>;
  dispose: () => Promise<void>;
};

function unavailableHandle(): SemanticSearchHandle {
  return {
    available: false,
    search: async () => [],
    dispose: async () => {},
  };
}

export type SemanticSearchHostDeps = {
  config: SemanticSearchPluginConfig | undefined;
  logger: Logger;
};

// Wires this host to a semanticd sidecar over HTTP -- never throws, always
// resolves to an unavailable handle if semantic search isn't configured, so a
// caller can fail open to lexical-only search.
export function createSemanticSearchCore(deps: SemanticSearchHostDeps): SemanticSearchHandle {
  if (deps.config?.enabled === false) {
    return unavailableHandle();
  }

  const semanticdUrl = deps.config?.semanticdUrl;
  if (!semanticdUrl) {
    deps.logger.warn(
      "semantic search: SIGNAL_SEMANTICD_URL not set, falling back to lexical-only search",
    );
    return unavailableHandle();
  }

  const client = createSemanticdClient(semanticdUrl);

  return {
    available: true,
    search: async (searchTerm, limit) => {
      if (!searchTerm) return [];
      try {
        const matches = await client.query(searchTerm, limit);
        return matches.map((match) => ({
          messageId: match.sourceId,
          snippet: match.snippet,
          score: match.score,
          startLine: match.startLine,
          endLine: match.endLine,
        }));
      } catch (err) {
        deps.logger.warn(
          `semantic search: query against semanticd failed, falling back to lexical-only search: ${describe(err)}`,
        );
        return [];
      }
    },
    dispose: async () => {},
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

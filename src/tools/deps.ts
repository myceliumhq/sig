import type { MessageStore } from "../ingest/store.js";
import type { SemanticSearchHandle } from "../semantic/handle.js";
import type { SignalClient } from "../signal-client.js";

// Everything the MCP tool surface reads from. The store is the local SQLite
// message store the ingestion daemon writes; the client issues JSON-RPC to the
// same daemon's socket for sends/reactions/directory lookups; semantic is the
// (optional) sidecar handle for hybrid search.
export interface SignalToolDeps {
  client: SignalClient;
  store: MessageStore;
  semantic: SemanticSearchHandle;
}

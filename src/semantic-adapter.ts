import type { SourceAdapter } from "@myceliumhq/index";
import { MessageStore } from "./ingest/store.js";
import { resolveDbPath } from "./paths.js";
import { createSignalSourceAdapter } from "./semantic/source-adapter.js";

// Public entrypoint for external hosts that want to sync this source --
// semanticd-bin.ts passes createAdapter()'s return value straight into
// @myceliumhq/semanticd's runSemanticd().
export { MessageStore } from "./ingest/store.js";
export { createSignalSourceAdapter } from "./semantic/source-adapter.js";

// Zero-argument factory returning a ready SourceAdapter. Reads its own store
// location from SIGNAL_DB (or the default state-dir path) -- unlike ppl/tri,
// there's no remote API to authenticate against; the adapter indexes the local
// SQLite store the ingestion daemon writes. Point SIGNAL_DB at that same store.
export function createAdapter(): SourceAdapter<string> {
  const store = new MessageStore(resolveDbPath());
  return createSignalSourceAdapter(store);
}

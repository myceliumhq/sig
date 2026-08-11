import { createHash } from "node:crypto";
import type { SourceAdapter } from "@myceliumhq/index";
import type { MessageStore } from "../ingest/store.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const PAGE_SIZE = 500;

// The Signal source-adapter is unusual among the mycelium apps: it reads
// straight from the LOCAL SQLite store the ingestion daemon already wrote,
// rather than re-fetching from a remote API (ppl/tri fetch from paperless-ngx/
// Trilium). sig already holds authoritative local state, so there's nothing to
// re-fetch -- the indexed content unit is one message, id `source:ts` (the
// store's UNIQUE(source, ts) natural key, like paperless with no free content
// hash).
//
// Messages are immutable once received (Signal has no server-side edit that we
// re-ingest as the same row), so listChanged is purely append-driven and
// keyed on the ts watermark; contentHash still lets @myceliumhq/index dedup
// re-indexing the same row after a resumption.
export function createSignalSourceAdapter(store: MessageStore): SourceAdapter<string> {
  return {
    name: "signal",

    async *listChanged(since) {
      // `since` is an ISO string watermark (or undefined on first sync); the
      // store keys on integer ms. Ascending by ts so @myceliumhq/index's
      // resumption watermark (set to the last item of each page) advances
      // monotonically instead of excluding older-but-unseen messages.
      let sinceMs = since ? Date.parse(since) : Number.NaN;
      if (!Number.isFinite(sinceMs)) sinceMs = 0;
      while (true) {
        const rows = store.changedForIndex(sinceMs, PAGE_SIZE);
        if (rows.length === 0) return;
        for (const row of rows) {
          yield {
            id: row.id,
            contentHash: hashContent(row.body),
            modifiedAt: new Date(row.ts).toISOString(),
          };
          sinceMs = row.ts;
        }
        if (rows.length < PAGE_SIZE) return;
      }
    },

    // Deletion backstop for reconcile(). sig never deletes ingested messages,
    // so in practice this always matches the stored set -- but implementing it
    // keeps reconcile() a supported no-op rather than an unsupported skip, and
    // it's cheap (ids only, no bodies).
    async *listAllIds() {
      for (const id of store.allIndexableIds()) {
        yield id;
      }
    },

    async fetchContent(id) {
      return store.bodyForId(id);
    },
  };
}

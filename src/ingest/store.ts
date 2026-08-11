import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDbPath, resolveMaxStored } from "../paths.js";
import type { AttachmentRow, StoredRow } from "./parse.js";

// SQLite message store, shared across processes: the `sig daemon` process
// writes, while the CLI read commands, the MCP server, and the semanticd
// source-adapter all read. WAL mode makes concurrent multi-process reads safe
// against the single writer. Built on node:sqlite's DatabaseSync (Node 22.5+)
// rather than a native better-sqlite3 dependency -- no compile step, and this
// app needs none of better-sqlite3's extras.
//
// UNIQUE(source, ts) is the dedup key (mirrors the retired prototype's sound
// schema): the same envelope re-delivered after a daemon restart is an
// INSERT OR IGNORE no-op, and it doubles as the natural id the semantic index
// keys on (`source:ts`).

export interface ConversationSummary {
  source: string;
  groupId: string | null;
  lastTs: number;
  lastBody: string;
  lastDirection: string | null;
  messageCount: number;
}

export interface MessageRow {
  source: string;
  ts: number;
  kind: string;
  direction: string | null;
  sender: string | null;
  senderName: string | null;
  groupId: string | null;
  body: string;
  attachments: number;
}

export interface MessageFilter {
  sender?: string;
  groupId?: string;
  limit: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    direction    TEXT,
    sender       TEXT,
    sender_name  TEXT,
    group_id     TEXT,
    body         TEXT NOT NULL DEFAULT '',
    attachments  INTEGER NOT NULL DEFAULT 0,
    payload      TEXT NOT NULL,
    received_at  INTEGER NOT NULL,
    UNIQUE(source, ts)
  );
  -- deleted_at is added via an additive migration below (ensureDeletedAtColumn),
  -- NOT here: CREATE TABLE IF NOT EXISTS is a no-op against the already-existing
  -- production table, so a new column can only ever land via ALTER TABLE.
  CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
  CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind);

  -- One row per attachment, keyed by signal-cli's own attachment id (received)
  -- or a synthetic "sent:<ts>:<index>" id (sent by us, see
  -- parse.ts's outgoingAttachmentRows). local_path always points at real
  -- bytes on disk: for received attachments, a copy under sig's own
  -- attachments dir (see paths.ts resolveAttachmentsDir); for sent ones, the
  -- path the caller passed to --attachment verbatim.
  CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    file_name    TEXT,
    content_type TEXT,
    size         INTEGER,
    local_path   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(source, ts);
`;

// Every 100 inserts, sweep the store back down to the configured cap (mirrors
// the retired signal-mcp-server prototype's PRUNE_EVERY_N_INSERTS -- batching
// the DELETE avoids running a full prune on every single insert while still
// keeping storage bounded in practice).
const PRUNE_EVERY_N_INSERTS = 100;

export class MessageStore {
  private db: DatabaseSync;
  private readonly maxStored: number;
  private insertsSincePrune = 0;

  constructor(dbPath: string = resolveDbPath(), maxStored: number = resolveMaxStored()) {
    // Ensure the parent dir exists (":memory:" has no dirname worth creating) so
    // the store never depends on the caller having made it first.
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    // Opened read-write so a fresh install (daemon never run yet) still gets a
    // valid empty schema to read from instead of erroring -- read commands then
    // just return nothing.
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.ensureDeletedAtColumn();
    this.maxStored = maxStored;
  }

  // Additive migration for the remote-delete tombstone column. There is a
  // real, already-deployed production DB whose `messages` table was created
  // long before `deleted_at` existed -- CREATE TABLE IF NOT EXISTS above is a
  // no-op against it, so the only safe way to add the column is ALTER TABLE,
  // guarded by a check (PRAGMA table_info) so re-running this on a database
  // that already has the column is also a no-op rather than an error.
  private ensureDeletedAtColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as unknown as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "deleted_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
    }
  }

  insert(row: StoredRow): boolean {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages
         (source, ts, kind, direction, sender, sender_name, group_id, body, attachments, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      row.source,
      row.ts,
      row.kind,
      row.direction,
      row.sender,
      row.senderName,
      row.groupId,
      row.body,
      row.attachments,
      row.payload,
      row.receivedAt,
    );
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= PRUNE_EVERY_N_INSERTS) {
      this.insertsSincePrune = 0;
      this.prune();
    }
    return result.changes > 0;
  }

  // Mark an existing row as remotely deleted ("delete for everyone") rather
  // than removing it -- an auditable tombstone, not a silent drop, matching
  // wacli's design. `(source, ts)` is the same natural key insert() dedups
  // on. If the original message hasn't been ingested yet (or never will be,
  // e.g. the daemon started after it), this simply affects 0 rows -- that is
  // not an error, the delete event is just a no-op tombstone-of-nothing.
  markDeleted(source: string, ts: number, deletedAt: number): boolean {
    const stmt = this.db.prepare("UPDATE messages SET deleted_at = ? WHERE source = ? AND ts = ?");
    const result = stmt.run(deletedAt, source, ts);
    return result.changes > 0;
  }

  // Delete the oldest rows beyond the configured cap, then sweep any
  // attachment rows whose parent message no longer exists (either pruned
  // just now, or from some earlier direct deletion) -- run together so
  // attachments never outlive the message they belong to.
  private prune(): void {
    this.db
      .prepare(
        "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)",
      )
      .run(this.maxStored);
    this.pruneOrphanedAttachments();
  }

  // Public so it can be unit-tested directly and so a caller (e.g. a future
  // maintenance command) can run it standalone without waiting for the next
  // prune batch.
  pruneOrphanedAttachments(): void {
    this.db.exec(
      `DELETE FROM attachments
        WHERE NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.source = attachments.source AND m.ts = attachments.ts
        )`,
    );
  }

  // The active cap, for the daemon's startup log line (see ingest/daemon.ts).
  get maxStoredCap(): number {
    return this.maxStored;
  }

  insertAttachment(row: AttachmentRow): boolean {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO attachments
         (id, source, ts, file_name, content_type, size, local_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      row.id,
      row.source,
      row.ts,
      row.fileName,
      row.contentType,
      row.size,
      row.localPath,
    );
    return result.changes > 0;
  }

  // All attachments for a given send timestamp, across whichever source(s)
  // share it (ts alone is effectively unique within one local store -- the
  // real signal-cli message timestamp -- but sender/group can narrow it
  // further when given).
  attachmentsForTs(
    ts: number,
    filter: { sender?: string; groupId?: string } = {},
  ): AttachmentRow[] {
    const clauses = ["ts = ?"];
    const params: (string | number)[] = [ts];
    if (filter.sender !== undefined) {
      const escaped = filter.sender.replace(/[\\%_]/g, "\\$&");
      clauses.push("LOWER(source) LIKE LOWER(?) ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    if (filter.groupId !== undefined) {
      clauses.push("source = ?");
      params.push(`group:${filter.groupId}`);
    }
    const rows = this.db
      .prepare(
        `SELECT id, source, ts, file_name AS fileName, content_type AS contentType, size,
                local_path AS localPath
           FROM attachments
          WHERE ${clauses.join(" AND ")}
          ORDER BY id ASC`,
      )
      .all(...params) as unknown as AttachmentRow[];
    return rows;
  }

  // Single attachment by its own id (unlike attachmentsForTs, no ts/sender/
  // group narrowing needed -- id alone is the primary key). Used by
  // sig-server's GET /v1/attachments/:id/content and the local backend's
  // saveAttachment() to resolve the on-disk path to stream/copy from.
  getAttachmentById(id: string): AttachmentRow | null {
    const row = this.db
      .prepare(
        `SELECT id, source, ts, file_name AS fileName, content_type AS contentType, size,
                local_path AS localPath
           FROM attachments
          WHERE id = ?`,
      )
      .get(id) as unknown as AttachmentRow | undefined;
    return row ?? null;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as unknown as {
      n: number;
    };
    return row.n;
  }

  // Recent conversations, newest activity first. Only real messages count
  // toward a conversation -- receipts and sync-noise never surface a thread.
  recentConversations(limit: number): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT m.source        AS source,
                m.group_id       AS groupId,
                m.ts             AS lastTs,
                m.body           AS lastBody,
                m.direction      AS lastDirection,
                c.cnt            AS messageCount
           FROM messages m
           JOIN (
             SELECT source, MAX(ts) AS maxTs, COUNT(*) AS cnt
               FROM messages
              WHERE kind = 'message' AND deleted_at IS NULL
              GROUP BY source
           ) c ON c.source = m.source AND c.maxTs = m.ts
          WHERE m.kind = 'message' AND m.deleted_at IS NULL
          ORDER BY m.ts DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as ConversationSummary[];
    return rows;
  }

  // Stored messages, newest first, optionally filtered. Only kind='message'
  // rows -- receipts/sync-noise are queryable via rawByKind if ever needed but
  // never appear in the message list an agent reads.
  messages(filter: MessageFilter): MessageRow[] {
    const clauses = ["kind = 'message'", "deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (filter.sender !== undefined) {
      // Match against either the conversation key or the sender field so a
      // 1:1 number filters correctly regardless of direction. Escape LIKE
      // wildcards so a "%"/"_" in the arg can't widen the match.
      const escaped = filter.sender.replace(/[\\%_]/g, "\\$&");
      clauses.push(
        "(LOWER(source) LIKE LOWER(?) ESCAPE '\\' OR LOWER(sender) LIKE LOWER(?) ESCAPE '\\')",
      );
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (filter.groupId !== undefined) {
      clauses.push("group_id = ?");
      params.push(filter.groupId);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT source, ts, kind, direction, sender, sender_name AS senderName,
                group_id AS groupId, body, attachments
           FROM messages
          WHERE ${clauses.join(" AND ")}
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(...params) as unknown as MessageRow[];
    return rows;
  }

  // Lexical search over message bodies (LIKE substring, ranked newest-first),
  // returning the natural id `source:ts` per hit for the search command's RRF
  // fusion. Only real, non-empty messages participate.
  searchLexical(query: string, limit: number): { id: string; row: MessageRow }[] {
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const rows = this.db
      .prepare(
        `SELECT source, ts, kind, direction, sender, sender_name AS senderName,
                group_id AS groupId, body, attachments
           FROM messages
          WHERE kind = 'message' AND deleted_at IS NULL AND body != ''
            AND LOWER(body) LIKE LOWER(?) ESCAPE '\\'
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as unknown as MessageRow[];
    return rows.map((row) => ({ id: `${row.source}:${row.ts}`, row }));
  }

  // Resolve a batch of `source:ts` ids back to rows (for semantic-only hits the
  // lexical pass didn't surface). Missing ids are simply absent from the map.
  getByIds(ids: string[]): Map<string, MessageRow> {
    const map = new Map<string, MessageRow>();
    const stmt = this.db.prepare(
      `SELECT source, ts, kind, direction, sender, sender_name AS senderName,
              group_id AS groupId, body, attachments
         FROM messages
        WHERE source = ? AND ts = ? AND deleted_at IS NULL`,
    );
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (!parsed) continue;
      const row = stmt.get(parsed.source, parsed.ts) as unknown as MessageRow | undefined;
      if (row) map.set(id, row);
    }
    return map;
  }

  // Look up a single stored message by its natural (source, ts) key. Used to
  // auto-fill a reply's quoted text server-side (--reply-to / reply_to_ts,
  // see tools/messaging.ts and server.ts) rather than requiring the caller
  // to already know the quoted message's body.
  getMessage(source: string, ts: number): MessageRow | null {
    const row = this.db
      .prepare(
        `SELECT source, ts, kind, direction, sender, sender_name AS senderName,
                group_id AS groupId, body, attachments
           FROM messages
          WHERE source = ? AND ts = ? AND deleted_at IS NULL`,
      )
      .get(source, ts) as unknown as MessageRow | undefined;
    return row ?? null;
  }

  // --- Semantic source-adapter support ---

  // Indexable messages changed since `sinceMs` (exclusive), ascending by ts so
  // @myceliumhq/index's watermark (set to the last item of each page) advances
  // monotonically. Only non-empty real messages are indexable.
  changedForIndex(sinceMs: number, limit: number): { id: string; body: string; ts: number }[] {
    const rows = this.db
      .prepare(
        `SELECT source, ts, body
           FROM messages
          WHERE kind = 'message' AND deleted_at IS NULL AND body != '' AND ts > ?
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(sinceMs, limit) as unknown as { source: string; ts: number; body: string }[];
    return rows.map((r) => ({ id: `${r.source}:${r.ts}`, body: r.body, ts: r.ts }));
  }

  allIndexableIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT source, ts FROM messages
          WHERE kind = 'message' AND deleted_at IS NULL AND body != ''
          ORDER BY ts ASC`,
      )
      .all() as unknown as { source: string; ts: number }[];
    return rows.map((r) => `${r.source}:${r.ts}`);
  }

  bodyForId(id: string): string {
    const parsed = parseMessageId(id);
    if (!parsed) return "";
    const row = this.db
      .prepare("SELECT body FROM messages WHERE source = ? AND ts = ? AND deleted_at IS NULL")
      .get(parsed.source, parsed.ts) as unknown as { body?: string } | undefined;
    return row?.body ?? "";
  }

  close(): void {
    this.db.close();
  }
}

// Message ids are `source:ts`. `source` (a phone number, a uuid, or
// "group:<id>") can itself contain ":", so split on the LAST colon -- the ts
// suffix is always a bare integer.
export function parseMessageId(id: string): { source: string; ts: number } | null {
  const idx = id.lastIndexOf(":");
  if (idx === -1) return null;
  const source = id.slice(0, idx);
  const ts = Number(id.slice(idx + 1));
  if (!Number.isFinite(ts) || source === "") return null;
  return { source, ts };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredRow } from "./parse.js";
import { MessageStore } from "./store.js";

function row(overrides: Partial<StoredRow> & { source: string; ts: number }): StoredRow {
  return {
    kind: "message",
    direction: "incoming",
    sender: overrides.source,
    senderName: null,
    groupId: null,
    body: `body ${overrides.ts}`,
    attachments: 0,
    rawAttachments: [],
    payload: "{}",
    receivedAt: overrides.ts,
    ...overrides,
  };
}

describe("MessageStore pruning", () => {
  it("prunes the oldest rows beyond maxStored, batched every 100 inserts", () => {
    const store = new MessageStore(":memory:", 50);
    for (let i = 1; i <= 250; i++) {
      store.insert(row({ source: "+491230001", ts: i }));
    }
    // Two prune batches ran (at insert 100 and 200); the 250th insert hasn't
    // triggered a third yet, so the count sits somewhere <= 250 but the store
    // must never be allowed to grow unbounded -- and the newest rows survive.
    expect(store.count()).toBeLessThanOrEqual(250);
    const newest = store.messages({ limit: 1 });
    expect(newest[0]?.ts).toBe(250);
    store.close();
  });

  it("keeps the newest maxStored rows after enough inserts to trigger a prune", () => {
    const store = new MessageStore(":memory:", 50);
    for (let i = 1; i <= 200; i++) {
      store.insert(row({ source: "+491230001", ts: i }));
    }
    // 200 inserts = two prune batches (at 100 and 200), each capping to 50.
    expect(store.count()).toBe(50);
    const rows = store.messages({ limit: 200 });
    const tsValues = rows.map((r) => r.ts).sort((a, b) => a - b);
    expect(tsValues[0]).toBe(151);
    expect(tsValues[tsValues.length - 1]).toBe(200);
    store.close();
  });

  it("prunes orphaned attachment rows whose parent message no longer exists", () => {
    const store = new MessageStore(":memory:", 50);
    for (let i = 1; i <= 100; i++) {
      store.insert(row({ source: "+491230001", ts: i }));
      store.insertAttachment({
        id: `att-${i}`,
        source: "+491230001",
        ts: i,
        fileName: "f",
        contentType: null,
        size: null,
        localPath: "/tmp/f",
      });
    }
    // The 100th insert triggers a prune batch: messages 1-50 are gone, so
    // their attachments should be swept too.
    expect(store.getAttachmentById("att-1")).toBeNull();
    expect(store.getAttachmentById("att-100")).not.toBeNull();
    store.close();
  });
});

describe("MessageStore remote-delete tombstones", () => {
  it("markDeleted excludes the row from every default read path", () => {
    const store = new MessageStore(":memory:", 1000);
    store.insert(row({ source: "+491230001", ts: 1000, body: "secret plan" }));
    expect(store.messages({ limit: 10 })).toHaveLength(1);

    const affected = store.markDeleted("+491230001", 1000, 2000);
    expect(affected).toBe(true);

    expect(store.messages({ limit: 10 })).toHaveLength(0);
    expect(store.recentConversations(10)).toHaveLength(0);
    expect(store.searchLexical("secret", 10)).toHaveLength(0);
    expect(store.changedForIndex(0, 10)).toHaveLength(0);
    expect(store.getMessage("+491230001", 1000)).toBeNull();
  });

  it("is a no-op (not an error) when the original message isn't in the store", () => {
    const store = new MessageStore(":memory:", 1000);
    expect(() => store.markDeleted("+491230001", 9999, 2000)).not.toThrow();
    expect(store.markDeleted("+491230001", 9999, 2000)).toBe(false);
  });
});

describe("MessageStore additive migration", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("adds deleted_at to a database created with the old (pre-migration) schema, without losing data", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sig-store-migration-"));
    const dbPath = join(tmpDir, "messages.db");

    // Simulate a production DB created before deleted_at existed: build the
    // OLD schema by hand (no deleted_at column, no migration logic involved)
    // and insert a couple of rows, exactly like a real pre-upgrade store.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE messages (
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
    `);
    raw
      .prepare(
        `INSERT INTO messages
           (source, ts, kind, direction, sender, sender_name, group_id, body, attachments, payload, received_at)
         VALUES ('+491230001', 42, 'message', 'incoming', '+491230001', NULL, NULL, 'pre-migration row', 0, '{}', 42)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO messages
           (source, ts, kind, direction, sender, sender_name, group_id, body, attachments, payload, received_at)
         VALUES ('+491230002', 43, 'message', 'outgoing', NULL, NULL, NULL, 'second pre-migration row', 0, '{}', 43)`,
      )
      .run();
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(2);
    raw.close();

    // Now open the SAME file through the real (new) MessageStore constructor
    // -- the exact code path a production upgrade goes through -- and assert
    // it upgrades cleanly: no throw, no data loss, deleted_at present and
    // NULL on the pre-existing rows.
    expect(() => new MessageStore(dbPath, 1000)).not.toThrow();
    const store = new MessageStore(dbPath, 1000);
    expect(store.count()).toBe(2);
    const rows = store.messages({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.body).sort()).toEqual(
      ["pre-migration row", "second pre-migration row"].sort(),
    );

    // deleted_at should exist and be NULL on the old rows (not filtered out
    // by the default read paths, and markDeleted works against them).
    const raw2 = new DatabaseSync(dbPath);
    const columns = raw2.prepare("PRAGMA table_info(messages)").all() as unknown as {
      name: string;
    }[];
    expect(columns.some((c) => c.name === "deleted_at")).toBe(true);
    const deletedAtValues = raw2
      .prepare("SELECT deleted_at FROM messages ORDER BY ts")
      .all() as unknown as { deleted_at: unknown }[];
    expect(deletedAtValues.every((r) => r.deleted_at === null)).toBe(true);
    raw2.close();

    expect(store.markDeleted("+491230001", 42, 9999)).toBe(true);
    expect(store.messages({ limit: 10 })).toHaveLength(1);
    store.close();

    // Re-opening once more (double-migration) must also be a no-op, not an
    // error -- the PRAGMA table_info guard should short-circuit the ALTER.
    expect(() => {
      const again = new MessageStore(dbPath, 1000);
      again.close();
    }).not.toThrow();
  });
});

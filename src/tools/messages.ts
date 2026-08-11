import { type Static, Type } from "typebox";
import { type AnyAgentTool, toToolResult } from "../agent-tool.js";
import type { MessageStore } from "../ingest/store.js";
import { MAX_CONVERSATIONS_LIMIT, MAX_MESSAGES_LIMIT, MAX_SEARCH_LIMIT } from "../limits.js";
import { hybridSearch } from "../search-core.js";
import type { SemanticSearchHandle } from "../semantic/handle.js";

// Read tools over the local SQLite message store the ingestion daemon writes.
// These never touch signal-cli -- the daemon is the sole receiver, and these
// just read what it already persisted. Per-tool limits come from ../limits.ts,
// shared with the matching CLI command so `--help` and the tool schema never
// silently disagree on how much an agent can ask for in one call.

const DEFAULT_LIMIT = 20;

const listConversationsParams = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_CONVERSATIONS_LIMIT,
      description: `Max conversations (<= ${MAX_CONVERSATIONS_LIMIT}).`,
    }),
  ),
});

export function createListConversationsTool(store: MessageStore): AnyAgentTool {
  return {
    name: "signal_list_conversations",
    label: "List recent Signal conversations",
    description:
      "List recent Signal conversations from the local message store, newest activity first -- each " +
      "with its conversation key (a contact number or group:<id>), the last message preview, and a " +
      "message count. Requires the `sig daemon` ingestion process to be running to have any data.",
    parameters: listConversationsParams,
    execute: async (_id, params: Static<typeof listConversationsParams>) => {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const conversations = store.recentConversations(limit).map((c) => ({
        source: c.source,
        group_id: c.groupId,
        last_ts: c.lastTs,
        last_time: new Date(c.lastTs).toISOString(),
        last_direction: c.lastDirection,
        last_body: c.lastBody,
        message_count: c.messageCount,
      }));
      return toToolResult({ count: conversations.length, conversations });
    },
  };
}

const listMessagesParams = Type.Object({
  sender: Type.Optional(
    Type.String({
      description:
        "Filter to a conversation by contact number/uuid (matches the conversation key or sender).",
    }),
  ),
  group_id: Type.Optional(Type.String({ description: "Filter to a specific group's messages." })),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_MESSAGES_LIMIT,
      description: `Max messages (<= ${MAX_MESSAGES_LIMIT}).`,
    }),
  ),
});

export function createListMessagesTool(store: MessageStore): AnyAgentTool {
  return {
    name: "signal_list_messages",
    label: "Read stored Signal messages",
    description:
      "Read stored Signal messages (newest first), optionally filtered by sender or group. Each " +
      "message includes its `ts` (send timestamp) -- pass that to signal_send_reaction as " +
      "target_timestamp to react to it. Receipts and sync-noise are excluded.",
    parameters: listMessagesParams,
    execute: async (_id, params: Static<typeof listMessagesParams>) => {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const rows = store
        .messages({ sender: params.sender, groupId: params.group_id, limit })
        .map((m) => ({
          source: m.source,
          ts: m.ts,
          time: new Date(m.ts).toISOString(),
          direction: m.direction,
          sender: m.sender,
          sender_name: m.senderName,
          group_id: m.groupId,
          body: m.body,
          attachments: m.attachments,
        }));
      return toToolResult({ count: rows.length, messages: rows });
    },
  };
}

const listAttachmentsParams = Type.Object({
  ts: Type.Integer({
    description: "The message's send timestamp (ms) -- the `ts` from signal_list_messages/search.",
  }),
  sender: Type.Optional(
    Type.String({ description: "Narrow to a 1:1 conversation by contact number/uuid." }),
  ),
  group_id: Type.Optional(Type.String({ description: "Narrow to a specific group." })),
});

// Metadata only -- deliberately never includes local_path. This tool backs
// both the MCP surface and sig-server's GET /v1/attachments (see
// src/server.ts): a remote caller has no use for a path on the server's own
// filesystem, and returning one would leak server-local layout. Fetch actual
// bytes via signal_send_message... no -- via the CLI's `save-attachment`
// command / sig-server's GET /v1/attachments/:id/content instead.
export function createListAttachmentsTool(store: MessageStore): AnyAgentTool {
  return {
    name: "signal_list_attachments",
    label: "List attachments on a Signal message",
    description:
      "List attachment metadata (id, filename, content type, size) for a specific message, " +
      "identified by its send timestamp (`ts`). Returns no local file path -- attachment bytes " +
      "aren't fetchable through this tool.",
    parameters: listAttachmentsParams,
    execute: async (_id, params: Static<typeof listAttachmentsParams>) => {
      const rows = store
        .attachmentsForTs(params.ts, { sender: params.sender, groupId: params.group_id })
        .map((a) => ({
          id: a.id,
          source: a.source,
          ts: a.ts,
          file_name: a.fileName,
          content_type: a.contentType,
          size: a.size,
        }));
      return toToolResult({ count: rows.length, attachments: rows });
    },
  };
}

const searchMessagesParams = Type.Object({
  query: Type.String({ description: "Free-text search query over message bodies." }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `Max results (<= ${MAX_SEARCH_LIMIT}).`,
    }),
  ),
});

export function createSearchMessagesTool(
  store: MessageStore,
  semantic: SemanticSearchHandle,
): AnyAgentTool {
  return {
    name: "signal_search_messages",
    label: "Search Signal messages",
    description:
      "Search stored Signal message text. Lexical by default; when a sig-semanticd sidecar is " +
      "configured, results are fused with a semantic pass (RRF) automatically. Each result row has " +
      "match_source (lexical/semantic/both) when semantic ran -- a result set with zero lexical " +
      "hits (all `semantic`) is the real 'probably found nothing' signal, since cosine similarity " +
      "has no calibrated zero-results floor.",
    parameters: searchMessagesParams,
    execute: async (_id, params: Static<typeof searchMessagesParams>) => {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const result = await hybridSearch(store, semantic, params.query, limit);
      return toToolResult({
        count: result.rows.length,
        used_semantic: result.usedSemantic,
        truncated: result.truncated,
        lexical_hits: result.lexicalCount,
        results: result.rows,
      });
    },
  };
}

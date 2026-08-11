import { type Static, Type } from "typebox";
import { type AnyAgentTool, toToolResult } from "../agent-tool.js";
import { isE164 } from "../e164.js";
import { outgoingAttachmentRows, outgoingRowFromLocalSend } from "../ingest/parse.js";
import type { MessageStore } from "../ingest/store.js";
import { createSendRateLimiter } from "../send-rate-limit.js";
import type { SendTarget, SignalClient } from "../signal-client.js";

// Shared, module-level rate limiter for both send and react below -- one
// clock per process (see send-rate-limit.ts), covering both tools since a
// burst of either is equally spammy.
const checkSendRateLimit = createSendRateLimiter();

// Write tools. Both resolve to a 1:1 recipient (a phone number) OR a group id,
// never both -- the schema keeps them mutually exclusive at the type level and
// the executor enforces it at runtime.

// Validated identically to the CLI's `requireE164` (src/cli/api.ts) -- a
// malformed number is rejected here rather than round-tripping to signal-cli
// for a less legible rejection, keeping the CLI and MCP surfaces consistent.
function requireE164(value: string, label: string): string {
  if (!isE164(value)) {
    throw new Error(`${label} must be an E.164 phone number (e.g. +491700000000), got "${value}"`);
  }
  return value;
}

function resolveTarget(recipient: string | undefined, groupId: string | undefined): SendTarget {
  if (groupId !== undefined && groupId !== "") {
    return { groupId };
  }
  if (recipient !== undefined && recipient !== "") {
    return { recipient: requireE164(recipient, "recipient") };
  }
  throw new Error("either `recipient` (a phone number) or `group_id` is required");
}

const sendMessageParams = Type.Object({
  recipient: Type.Optional(
    Type.String({
      description:
        "Recipient phone number in E.164 (e.g. +491700000000) for a 1:1 message. Resolve a name " +
        "to a number via signal_list_contacts first. Mutually exclusive with group_id.",
    }),
  ),
  group_id: Type.Optional(
    Type.String({
      description:
        "Group id (from signal_list_groups) to send to a group. Mutually exclusive with recipient.",
    }),
  ),
  message: Type.String({ description: "The message text to send." }),
  attachments: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Local file paths to attach (paths on the machine running this tool -- e.g. sig-server's " +
        "host when reached through its POST /v1/send, which stages uploaded bytes to temp paths " +
        "before calling this).",
    }),
  ),
  reply_to_ts: Type.Optional(
    Type.Integer({
      description:
        "Quote/reply to a specific message by its send timestamp (`ts` from signal_list_messages). " +
        "The quoted text is auto-filled from this account's own local store when available.",
    }),
  ),
  reply_to_author: Type.Optional(
    Type.String({
      description:
        "Phone number of the author of the quoted message. Defaults to `recipient` for a 1:1 chat; " +
        "required (alongside reply_to_ts) when replying in a group.",
    }),
  ),
});

// `store` is where a sent message is recorded locally: Signal's protocol
// never echoes a device's own outbound sends back to that same device (only
// to *other* linked devices), so without this write the message would never
// appear in `signal_list_messages`/search/history -- live-verified against a
// real account. Recorded only after the RPC confirms delivery and returns the
// real sent-message timestamp.
export function createSendMessageTool(client: SignalClient, store: MessageStore): AnyAgentTool {
  return {
    name: "signal_send_message",
    label: "Send a Signal message",
    description:
      "Send a text message to a Signal contact (by phone number) or group (by group id). This " +
      "actually delivers a message from the user's account -- only call it when explicitly asked " +
      "to send something.",
    parameters: sendMessageParams,
    execute: async (_id, params: Static<typeof sendMessageParams>) => {
      const target = resolveTarget(params.recipient, params.group_id);
      const attachments = params.attachments ?? [];

      let quote: { timestamp: number; author: string; message?: string } | undefined;
      if (params.reply_to_ts !== undefined) {
        const quoteAuthor = params.reply_to_author ?? params.recipient;
        if (!quoteAuthor) {
          throw new Error(
            "reply_to_author is required (defaults to recipient for 1:1; must be given for a group)",
          );
        }
        requireE164(quoteAuthor, "reply_to_author");
        // Auto-fill the quoted text from this account's own local store
        // rather than requiring the caller to already know it -- the store
        // has direct access, same idea as sig-server looking up an
        // attachment's local path by id.
        const quotedSource = "groupId" in target ? `group:${target.groupId}` : quoteAuthor;
        const quoted = store.getMessage(quotedSource, params.reply_to_ts);
        quote = { timestamp: params.reply_to_ts, author: quoteAuthor, message: quoted?.body };
      }

      const warning = checkSendRateLimit();
      const result = await client.send(target, params.message, attachments, quote);
      const ts = result.timestamp ?? null;
      if (ts !== null) {
        const source = "groupId" in target ? `group:${target.groupId}` : target.recipient;
        store.insert(
          outgoingRowFromLocalSend({
            recipient: "groupId" in target ? undefined : target.recipient,
            groupId: "groupId" in target ? target.groupId : undefined,
            message: params.message,
            ts,
            attachmentCount: attachments.length,
          }),
        );
        for (const row of outgoingAttachmentRows({ source, ts, paths: attachments })) {
          store.insertAttachment(row);
        }
      }
      return toToolResult({
        sent: true,
        target,
        timestamp: ts,
        attachments: attachments.length,
        ...(warning ? { warning } : {}),
      });
    },
  };
}

const sendReactionParams = Type.Object({
  recipient: Type.Optional(
    Type.String({
      description:
        "Recipient phone number for a 1:1 reaction. Mutually exclusive with group_id. In a 1:1 " +
        "chat this is also the author of the target message unless target_author overrides it.",
    }),
  ),
  group_id: Type.Optional(
    Type.String({ description: "Group id to react within. Mutually exclusive with recipient." }),
  ),
  emoji: Type.String({ description: 'The reaction emoji, e.g. "👍".' }),
  target_author: Type.Optional(
    Type.String({
      description:
        "Phone number of the author of the message being reacted to. Defaults to `recipient` for " +
        "a 1:1 chat; required when reacting in a group (the group member who sent the message).",
    }),
  ),
  target_timestamp: Type.Integer({
    description:
      "The `ts` (send timestamp, ms) of the message being reacted to -- from signal_list_messages.",
  }),
  remove: Type.Optional(
    Type.Boolean({
      description: "Set true to remove a previously-sent reaction instead of adding one.",
    }),
  ),
});

export function createSendReactionTool(client: SignalClient): AnyAgentTool {
  return {
    name: "signal_send_reaction",
    label: "React to a Signal message",
    description:
      "Add (or remove) an emoji reaction to a specific Signal message. Identify the target message " +
      "by its author (target_author) and its send timestamp (target_timestamp, the `ts` from " +
      "signal_list_messages). Only call when explicitly asked to react.",
    parameters: sendReactionParams,
    execute: async (_id, params: Static<typeof sendReactionParams>) => {
      const target = resolveTarget(params.recipient, params.group_id);
      const targetAuthor = params.target_author ?? params.recipient;
      if (!targetAuthor) {
        throw new Error(
          "target_author is required (defaults to recipient for 1:1; must be given for a group)",
        );
      }
      requireE164(targetAuthor, "target_author");
      const warning = checkSendRateLimit();
      await client.sendReaction({
        target,
        emoji: params.emoji,
        targetAuthor,
        targetTimestamp: params.target_timestamp,
        remove: params.remove,
      });
      return toToolResult({
        reacted: true,
        removed: params.remove ?? false,
        target,
        target_author: targetAuthor,
        target_timestamp: params.target_timestamp,
        emoji: params.emoji,
        ...(warning ? { warning } : {}),
      });
    },
  };
}

// Envelope parsing + classification. signal-cli (with `-o json`) pushes every
// received item to the daemon's stdout. Live-verified against a real account
// (2026-08-12) that this is a FLAT object, not a JSON-RPC-wrapped
// notification:
//
//   {"envelope":{...},"account":"+491700000000"}
//
// NOT the `{"jsonrpc":"2.0","method":"receive","params":{"envelope":{...}}}`
// shape this file previously assumed -- that assumption was never actually
// exercised against a live receive (only outgoing/self-sent rows, written
// directly by outgoingRowFromLocalSend below, had ever been verified), so it
// silently dropped every single incoming envelope at the `method !== "receive"`
// gate with no error logged (by design, to ignore unrelated JSON-RPC command
// responses sharing the same socket/stdout). extractEnvelope() below accepts
// both shapes -- the flat one signal-cli 0.14.7 actually sends, and the
// wrapped one in case a future signal-cli version reintroduces it -- and
// still ignores plain command responses (`{"jsonrpc":"2.0","result":...}`),
// which never carry an `envelope` key at all.
//
// The envelope shape varies by item type (verified live against a real
// account):
//   * message FROM someone else -> envelope.dataMessage.message (+ attachments/
//     quote), optionally envelope.dataMessage.groupInfo for a group message.
//   * message sent BY you (incl. "Note to Self") -> envelope.syncMessage.
//     sentMessage.message, with a destination (1:1) or groupInfo (group).
//   * low-signal noise -> bare syncMessage:{}, syncMessage:{type:"CONTACTS_SYNC"},
//     delivery/read receipts (receiptMessage), typing indicators. These are
//     persisted for completeness/debugging but classified so message views and
//     semantic indexing can exclude them.
//
// Every row gets an explicit `kind` so the classification is decided exactly
// once, here, rather than re-derived ad hoc at each read site.

export type MessageKind = "message" | "reaction" | "receipt" | "sync-noise";
export type Direction = "incoming" | "outgoing";

export interface Attachment {
  id?: string;
  // signal-cli's own JsonAttachment record field is `filename` (lowercase
  // n), NOT `fileName` -- live-verified against signal-cli 0.14.7's actual
  // source (org.asamk.signal.json.JsonAttachment). The `fileName` spelling
  // silently read as undefined on every real envelope, so every stored
  // attachment's filename was always null even when signal-cli sent one.
  filename?: string | null;
  contentType?: string | null;
  size?: number;
}

export interface DataMessage {
  timestamp?: number;
  message?: string | null;
  quote?: { id?: number; author?: string; text?: string | null };
  attachments?: Attachment[];
  groupInfo?: { groupId?: string; type?: string };
  reaction?: {
    emoji?: string;
    targetAuthor?: string;
    targetSentTimestamp?: number;
    isRemove?: boolean;
  };
  // "Delete for everyone" from someone else. Per signal-cli's own
  // remote-delete.schema.json, `timestamp` is the ORIGINAL message's send
  // timestamp being deleted -- NOT this envelope's own timestamp. Flattened
  // as a sibling of `message`/`reaction` here, matching how every other
  // field on this interface (quote, attachments, groupInfo) is already a
  // flattened sibling rather than nested under some wrapper -- consistent
  // with this codebase's established convention for this type.
  remoteDelete?: { timestamp?: number };
}

export interface SentMessage {
  destination?: string | null;
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  timestamp?: number;
  message?: string | null;
  quote?: { id?: number; author?: string; text?: string | null };
  attachments?: Attachment[];
  groupInfo?: { groupId?: string; type?: string };
  // signal-cli's JsonSyncDataMessage wraps JsonDataMessage with
  // @JsonUnwrapped -- every JsonDataMessage field (reaction included) is a
  // flat sibling of destination/destinationNumber/etc. here, exactly like
  // DataMessage above. A synced *sent* reaction therefore needs the same
  // dedicated handling as an incoming one (see toStoredRow's `data.reaction`
  // branch) -- without this field it silently fell through to the generic
  // outgoing-message branch and got stored as an empty-body message.
  reaction?: {
    emoji?: string;
    targetAuthor?: string;
    targetSentTimestamp?: number;
    isRemove?: boolean;
  };
  // Self-sent-then-deleted, synced from another linked device. Same shape/
  // semantics as DataMessage.remoteDelete above.
  remoteDelete?: { timestamp?: number };
}

export interface SyncMessage {
  sentMessage?: SentMessage;
  type?: string;
}

export interface Envelope {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: DataMessage;
  syncMessage?: SyncMessage;
  receiptMessage?: unknown;
  typingMessage?: unknown;
}

export interface ReceiveNotification {
  jsonrpc?: string;
  method?: string;
  params?: { envelope?: Envelope };
  // The shape signal-cli 0.14.7 actually sends (see this file's header
  // comment) -- a bare envelope + account, no JSON-RPC wrapper.
  envelope?: Envelope;
  account?: string;
}

// Pulls the envelope out of either shape described in this file's header
// comment. A plain JSON-RPC command response (`{"jsonrpc":"2.0","result":...}`)
// has neither `envelope` key and correctly yields undefined here, so callers
// that gate on this can't misclassify command responses as messages.
function extractEnvelope(notification: ReceiveNotification): Envelope | undefined {
  return notification.envelope ?? notification.params?.envelope;
}

// A row ready to persist. `source` is the *conversation key* -- the stable id a
// 1:1 or group thread is grouped by, identical for the incoming and outgoing
// halves of the same conversation (a contact's number for 1:1, "group:<id>"
// for a group), so `list conversations`/`list messages` group correctly.
export interface StoredRow {
  source: string;
  ts: number;
  kind: MessageKind;
  direction: Direction | null;
  sender: string | null;
  senderName: string | null;
  groupId: string | null;
  body: string;
  attachments: number;
  // Full per-attachment metadata (signal-cli's `id`, needed to locate the
  // downloaded file, plus filename/content-type/size for display). Only
  // `attachments` (the count) is persisted on the message row itself -- the
  // daemon uses this list separately to copy each file and insert its own
  // row (see ingest/daemon.ts and store.ts's `attachments` table). Entries
  // with no `id` are dropped (nothing to locate on disk).
  rawAttachments: Attachment[];
  payload: string;
  receivedAt: number;
}

const CONVERSATION_GROUP_PREFIX = "group:";

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

function attachmentCount(atts: Attachment[] | undefined): number {
  return Array.isArray(atts) ? atts.length : 0;
}

// Only attachments with an `id` are locatable on disk (signal-cli names the
// downloaded file by id) -- everything else is dropped rather than stored
// with no way to ever retrieve its bytes.
function rawAttachmentsOf(atts: Attachment[] | undefined): Attachment[] {
  return Array.isArray(atts) ? atts.filter((a) => typeof a.id === "string" && a.id !== "") : [];
}

export interface RemoteDeleteEvent {
  // Conversation key the deleted message lives under (same derivation as
  // toStoredRow's `source`).
  source: string;
  // The ORIGINAL message's send timestamp being deleted (remoteDelete.timestamp),
  // matched against messages.ts via UPDATE ... WHERE source = ? AND ts = ?.
  ts: number;
  // When the delete itself happened -- this envelope's own timestamp, or
  // Date.now() as a last resort.
  deletedAt: number;
}

// Detect a "delete for everyone" event and, if present, return enough to
// tombstone the original row via MessageStore.markDeleted -- checked BEFORE
// toStoredRow (see ingest/daemon.ts) so the delete notification itself never
// gets misclassified and inserted as a bogus empty-body message, the same
// class of bug already fixed for reactions above. Returns null for every
// other envelope shape, including non-`receive` notifications.
export function toRemoteDelete(notification: ReceiveNotification): RemoteDeleteEvent | null {
  const envelope = extractEnvelope(notification);
  if (!envelope || typeof envelope !== "object") return null;

  const senderNumber = firstNonEmpty(envelope.sourceNumber, envelope.source, envelope.sourceUuid);
  const deletedAt = envelope.timestamp ?? Date.now();

  const dataDeleteTs = envelope.dataMessage?.remoteDelete?.timestamp;
  if (dataDeleteTs !== undefined) {
    const groupId = firstNonEmpty(envelope.dataMessage?.groupInfo?.groupId);
    const source = groupId ? `${CONVERSATION_GROUP_PREFIX}${groupId}` : (senderNumber ?? "unknown");
    return { source, ts: dataDeleteTs, deletedAt };
  }

  const sent = envelope.syncMessage?.sentMessage;
  const sentDeleteTs = sent?.remoteDelete?.timestamp;
  if (sentDeleteTs !== undefined) {
    const groupId = firstNonEmpty(sent?.groupInfo?.groupId);
    const destination = firstNonEmpty(
      sent?.destinationNumber,
      sent?.destination,
      sent?.destinationUuid,
    );
    const source = groupId ? `${CONVERSATION_GROUP_PREFIX}${groupId}` : (destination ?? "self");
    return { source, ts: sentDeleteTs, deletedAt };
  }

  return null;
}

// Turn one parsed stdout line into a StoredRow, or null if the line isn't a
// `receive` notification at all (e.g. a JSON-RPC response to some command that
// happens to share the socket, or an unparseable line), OR is a remote-delete
// event (handled separately via toRemoteDelete/MessageStore.markDeleted --
// see ingest/daemon.ts -- rather than inserted as a new row).
export function toStoredRow(notification: ReceiveNotification): StoredRow | null {
  const envelope = extractEnvelope(notification);
  if (!envelope || typeof envelope !== "object") return null;

  const ts =
    envelope.timestamp ??
    envelope.dataMessage?.timestamp ??
    envelope.syncMessage?.sentMessage?.timestamp ??
    0;
  const senderNumber = firstNonEmpty(envelope.sourceNumber, envelope.source, envelope.sourceUuid);
  const senderName = firstNonEmpty(envelope.sourceName);
  const receivedAt = Date.now();
  const payload = JSON.stringify(notification);

  const base = {
    ts,
    sender: senderNumber,
    senderName,
    payload,
    receivedAt,
  };

  // Outgoing (sent by this account, synced from another linked device or a
  // "Note to Self").
  const sent = envelope.syncMessage?.sentMessage;
  if (sent) {
    // Handled separately via toRemoteDelete -- see this function's own
    // doc comment.
    if (sent.remoteDelete) return null;
    const groupId = firstNonEmpty(sent.groupInfo?.groupId);
    const destination = firstNonEmpty(
      sent.destinationNumber,
      sent.destination,
      sent.destinationUuid,
    );
    const source = groupId ? `${CONVERSATION_GROUP_PREFIX}${groupId}` : (destination ?? "self");

    // A synced *sent* reaction -- same shape/reasoning as the incoming
    // `data.reaction` branch below (see SentMessage.reaction's doc comment
    // for why this exists as a flat sibling here too). Checked before the
    // generic outgoing-message fallback so it isn't stored as an empty-body
    // "message" row.
    if (sent.reaction) {
      const emoji = sent.reaction.emoji ?? "?";
      const targetAuthor = sent.reaction.targetAuthor ?? "?";
      const targetTs = sent.reaction.targetSentTimestamp ?? "?";
      const verb = sent.reaction.isRemove ? "removed reaction" : "reacted";
      return {
        ...base,
        source,
        kind: "reaction",
        direction: "outgoing",
        groupId,
        body: `${verb} ${emoji} to message from ${targetAuthor} @ ${targetTs}`,
        attachments: 0,
        rawAttachments: [],
      };
    }

    return {
      ...base,
      source,
      kind: "message",
      direction: "outgoing",
      groupId,
      body: sent.message ?? "",
      attachments: attachmentCount(sent.attachments),
      rawAttachments: rawAttachmentsOf(sent.attachments),
    };
  }

  // Incoming data message (text or attachment-only).
  const data = envelope.dataMessage;
  if (data) {
    // Handled separately via toRemoteDelete -- see this function's own
    // doc comment.
    if (data.remoteDelete) return null;
    const groupId = firstNonEmpty(data.groupInfo?.groupId);
    const source = groupId ? `${CONVERSATION_GROUP_PREFIX}${groupId}` : (senderNumber ?? "unknown");

    // A reaction from someone else arrives as a dataMessage carrying only
    // `reaction`, no `message` text -- previously this fell through to the
    // generic branch below and was stored as an empty-body "message" row,
    // silently discarding the actual reaction (which emoji, on what
    // message). Give it its own kind with a real, searchable body instead.
    if (data.reaction) {
      const emoji = data.reaction.emoji ?? "?";
      const targetAuthor = data.reaction.targetAuthor ?? "?";
      const targetTs = data.reaction.targetSentTimestamp ?? "?";
      const verb = data.reaction.isRemove ? "removed reaction" : "reacted";
      return {
        ...base,
        source,
        kind: "reaction",
        direction: "incoming",
        groupId,
        body: `${verb} ${emoji} to message from ${targetAuthor} @ ${targetTs}`,
        attachments: 0,
        rawAttachments: [],
      };
    }

    return {
      ...base,
      source,
      kind: "message",
      direction: "incoming",
      groupId,
      body: data.message ?? "",
      attachments: attachmentCount(data.attachments),
      rawAttachments: rawAttachmentsOf(data.attachments),
    };
  }

  // Delivery/read receipts and typing indicators: real envelopes, no content.
  if (envelope.receiptMessage !== undefined || envelope.typingMessage !== undefined) {
    return {
      ...base,
      source: senderNumber ?? "unknown",
      kind: "receipt",
      direction: null,
      groupId: null,
      body: "",
      attachments: 0,
      rawAttachments: [],
    };
  }

  // Everything else -- bare syncMessage:{}, CONTACTS_SYNC, unknown types.
  return {
    ...base,
    source: senderNumber ?? "unknown",
    kind: "sync-noise",
    direction: null,
    groupId: null,
    body: "",
    attachments: 0,
    rawAttachments: [],
  };
}

// Build a StoredRow for a message this process just sent via `client.send()`.
// Signal's protocol does NOT echo a device's own outbound sends back to that
// same device (sync notifications only reach *other* linked devices), so
// without this the local store would never see anything sent from here --
// live-verified: `sig send` followed by `sig messages` showed zero rows until
// this was added. Call immediately after a successful send/RPC, using the
// timestamp the RPC call returns (the actual sent-message timestamp, which
// doubles as the id Signal/other clients reference for quoting/reactions).
export function outgoingRowFromLocalSend(params: {
  recipient?: string;
  groupId?: string;
  message: string;
  ts: number;
  attachmentCount?: number;
}): StoredRow {
  const groupId = params.groupId ?? null;
  const source = groupId
    ? `${CONVERSATION_GROUP_PREFIX}${groupId}`
    : (params.recipient ?? "unknown");
  return {
    source,
    ts: params.ts,
    kind: "message",
    direction: "outgoing",
    sender: null,
    senderName: null,
    groupId,
    body: params.message,
    attachments: params.attachmentCount ?? 0,
    // No signal-cli attachment `id` exists for a message we just sent (ids
    // are assigned to *received* attachments); the caller (send.ts /
    // messaging.ts) records attachment rows separately, directly from the
    // local file paths it was given -- see outgoingAttachmentRows() below.
    rawAttachments: [],
    payload: JSON.stringify({ locallySent: true, recipient: params.recipient ?? null, groupId }),
    receivedAt: Date.now(),
  };
}

// Attachment rows for a message this process just sent. Unlike received
// attachments (copied from signal-cli's download into sig's own attachments
// dir, see ingest/daemon.ts), a *sent* attachment's bytes already live
// wherever the caller pointed --attachment at -- so `localPath` is that path
// verbatim rather than a copy. If the file is later moved or deleted, the
// stored path simply stops resolving; that risk is the caller's, same as any
// other file-path-based CLI argument.
export function outgoingAttachmentRows(params: {
  source: string;
  ts: number;
  paths: string[];
}): AttachmentRow[] {
  return params.paths.map((path, index) => ({
    id: `sent:${params.ts}:${index}`,
    source: params.source,
    ts: params.ts,
    fileName: path.split("/").pop() ?? path,
    contentType: null,
    size: null,
    localPath: path,
  }));
}

export interface AttachmentRow {
  id: string;
  source: string;
  ts: number;
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  localPath: string;
}

// Parse a single raw stdout line into a notification, tolerating non-JSON /
// non-receive lines (returns null rather than throwing, so one bad line can't
// stall ingestion).
export function parseLine(line: string): ReceiveNotification | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as ReceiveNotification;
  } catch {
    return null;
  }
}

import { describe, expect, it } from "vitest";
import { parseLine, type ReceiveNotification, toRemoteDelete, toStoredRow } from "./parse.js";

function receive(envelope: Record<string, unknown>): ReceiveNotification {
  return { jsonrpc: "2.0", method: "receive", params: { envelope } };
}

describe("toStoredRow classification", () => {
  it("classifies an incoming data message from another person", () => {
    const row = toStoredRow(
      receive({
        source: "+491230001",
        sourceNumber: "+491230001",
        sourceName: "Alice",
        timestamp: 1000,
        dataMessage: { message: "hi there" },
      }),
    );
    expect(row).toMatchObject({
      source: "+491230001",
      kind: "message",
      direction: "incoming",
      sender: "+491230001",
      body: "hi there",
      groupId: null,
    });
  });

  it("classifies an incoming reaction with a real, searchable body instead of an empty one", () => {
    const row = toStoredRow(
      receive({
        source: "+491230001",
        sourceNumber: "+491230001",
        sourceName: "Alice",
        timestamp: 2000,
        dataMessage: {
          reaction: {
            emoji: "👍",
            targetAuthor: "+491230009",
            targetSentTimestamp: 1999,
            isRemove: false,
          },
        },
      }),
    );
    expect(row).toMatchObject({
      source: "+491230001",
      kind: "reaction",
      direction: "incoming",
      body: "reacted 👍 to message from +491230009 @ 1999",
      attachments: 0,
    });
  });

  it("keys an incoming group message on group:<id>", () => {
    const row = toStoredRow(
      receive({
        source: "+491230002",
        sourceNumber: "+491230002",
        timestamp: 1100,
        dataMessage: { message: "hi group", groupInfo: { groupId: "GRP==" } },
      }),
    );
    expect(row).toMatchObject({ source: "group:GRP==", groupId: "GRP==", kind: "message" });
  });

  it("classifies an outgoing synced sentMessage and keys it on the destination", () => {
    const row = toStoredRow(
      receive({
        source: "+490000",
        timestamp: 1200,
        syncMessage: { sentMessage: { destinationNumber: "+491230001", message: "on my way" } },
      }),
    );
    expect(row).toMatchObject({
      source: "+491230001",
      kind: "message",
      direction: "outgoing",
      body: "on my way",
    });
  });

  it("classifies bare and typed sync messages as sync-noise", () => {
    expect(toStoredRow(receive({ source: "+490000", timestamp: 1, syncMessage: {} }))?.kind).toBe(
      "sync-noise",
    );
    expect(
      toStoredRow(
        receive({ source: "+490000", timestamp: 2, syncMessage: { type: "CONTACTS_SYNC" } }),
      )?.kind,
    ).toBe("sync-noise");
  });

  it("classifies receipts as receipt kind", () => {
    const row = toStoredRow(
      receive({ source: "+491230001", timestamp: 1350, receiptMessage: { isDelivery: true } }),
    );
    expect(row?.kind).toBe("receipt");
    expect(row?.body).toBe("");
  });

  it("ignores non-receive notifications", () => {
    expect(
      toStoredRow({ jsonrpc: "2.0", method: "listContacts", params: { envelope: {} } }),
    ).toBeNull();
    expect(toStoredRow({ jsonrpc: "2.0" } as ReceiveNotification)).toBeNull();
  });

  it("does not misclassify a remote-delete data message as an empty-body message", () => {
    // Same class of bug already fixed for reactions above: a dataMessage
    // carrying only `remoteDelete` (no `message`, no `reaction`) must not
    // fall through to the generic incoming-message branch and get stored as
    // a bogus empty row -- it's handled separately via toRemoteDelete.
    const row = toStoredRow(
      receive({
        source: "+491230001",
        sourceNumber: "+491230001",
        timestamp: 5000,
        dataMessage: { remoteDelete: { timestamp: 1000 } },
      }),
    );
    expect(row).toBeNull();
  });

  it("does not misclassify a remote-delete synced sentMessage either", () => {
    const row = toStoredRow(
      receive({
        source: "+490000",
        timestamp: 5100,
        syncMessage: {
          sentMessage: { destinationNumber: "+491230001", remoteDelete: { timestamp: 1200 } },
        },
      }),
    );
    expect(row).toBeNull();
  });
});

describe("toRemoteDelete", () => {
  it("extracts the original message's timestamp (not the envelope's own) from a data message delete", () => {
    const event = toRemoteDelete(
      receive({
        source: "+491230001",
        sourceNumber: "+491230001",
        timestamp: 5000,
        dataMessage: { remoteDelete: { timestamp: 1000 } },
      }),
    );
    expect(event).toEqual({ source: "+491230001", ts: 1000, deletedAt: 5000 });
  });

  it("keys a group delete on group:<id>", () => {
    const event = toRemoteDelete(
      receive({
        source: "+491230002",
        sourceNumber: "+491230002",
        timestamp: 5200,
        dataMessage: { remoteDelete: { timestamp: 1300 }, groupInfo: { groupId: "GRP==" } },
      }),
    );
    expect(event).toEqual({ source: "group:GRP==", ts: 1300, deletedAt: 5200 });
  });

  it("extracts a self-sent-then-deleted event from a synced sentMessage", () => {
    const event = toRemoteDelete(
      receive({
        source: "+490000",
        timestamp: 5100,
        syncMessage: {
          sentMessage: { destinationNumber: "+491230001", remoteDelete: { timestamp: 1200 } },
        },
      }),
    );
    expect(event).toEqual({ source: "+491230001", ts: 1200, deletedAt: 5100 });
  });

  it("returns null for envelopes with no remoteDelete field at all", () => {
    expect(
      toRemoteDelete(
        receive({ source: "+491230001", timestamp: 1000, dataMessage: { message: "hi" } }),
      ),
    ).toBeNull();
    expect(toRemoteDelete({ jsonrpc: "2.0" } as ReceiveNotification)).toBeNull();
  });
});

describe("parseLine", () => {
  it("returns null on blank or non-JSON lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("not json")).toBeNull();
  });

  it("parses a valid JSON-RPC line", () => {
    const parsed = parseLine('{"jsonrpc":"2.0","method":"receive","params":{"envelope":{}}}');
    expect(parsed?.method).toBe("receive");
  });
});

import { describe, expect, it } from "vitest";
import { parseLine, type ReceiveNotification, toStoredRow } from "./parse.js";

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

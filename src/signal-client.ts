import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

// Thin JSON-RPC client over the signal-cli daemon's Unix domain socket
// (`daemon --socket <path>`). The wire protocol is newline-delimited JSON:
// one request object per line, one response object per line, matched by `id`.
//
// This is the *command* side of the split described in AGENTS.md: the
// ingestion daemon owns the signal-cli child process and reads received
// envelopes off its stdout; everything else (the CLI's send/react/contacts/
// groups commands and the MCP tools) reaches the same running daemon through
// this socket to issue JSON-RPC calls. We are never a second *receiver* -- the
// one-active-receiver-per-account bug that killed the earlier prototype
// (see AGENTS.md) can't recur, because only the owned child ever receives.
//
// Each call opens its own short-lived connection, writes one request, reads
// until the matching response arrives, then closes. The daemon may also push
// unsolicited `receive` notifications onto a connected socket; those carry no
// `id` (or an id we didn't send), so they're simply ignored here.

export type SignalRpcErrorShape = { code?: number; message?: string; data?: unknown };

export class SignalRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(err: SignalRpcErrorShape) {
    super(err.message ?? "signal-cli JSON-RPC error");
    this.name = "SignalRpcError";
    this.code = err.code;
    this.data = err.data;
  }
}

export type SignalClientOptions = {
  socketPath: string;
  account: string;
  // Per-call deadline. signal-cli is local, but a wedged daemon must not hang
  // a tool call indefinitely.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export type Contact = {
  number?: string | null;
  uuid?: string | null;
  name?: string | null;
  profileName?: string | null;
  givenName?: string | null;
  blocked?: boolean;
};

export type Group = {
  id?: string;
  name?: string | null;
  description?: string | null;
  members?: unknown[];
  blocked?: boolean;
  admins?: unknown[];
};

export type SendTarget = { recipient: string } | { groupId: string };

export type SignalClient = {
  account: string;
  send(
    target: SendTarget,
    message: string,
    attachments?: string[],
  ): Promise<{ timestamp?: number } & Record<string, unknown>>;
  sendReaction(params: {
    target: SendTarget;
    emoji: string;
    targetAuthor: string;
    targetTimestamp: number;
    remove?: boolean;
  }): Promise<Record<string, unknown>>;
  listContacts(): Promise<Contact[]>;
  listGroups(): Promise<Group[]>;
  // Escape hatch for any method not wrapped above.
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
};

// Low-level single request/response over one connection.
function rpcCall(
  options: SignalClientOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = randomUUID();
  const request = `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`;

  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `signal-cli JSON-RPC call "${method}" timed out after ${timeoutMs}ms ` +
              `(is the daemon running on ${options.socketPath}?)`,
          ),
        ),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== "") {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            parsed = undefined;
          }
          // Only the response carrying our own id settles this call; anything
          // else on the wire (pushed `receive` notifications, other ids) is
          // ignored.
          if (parsed && parsed.id === id) {
            if (parsed.error !== undefined) {
              finish(() => reject(new SignalRpcError(parsed.error as SignalRpcErrorShape)));
            } else {
              finish(() => resolve(parsed.result));
            }
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `cannot reach signal-cli daemon socket ${options.socketPath}: ${err.message} ` +
              "(start it with `sig daemon`)",
          ),
        ),
      );
    });

    socket.on("close", () => {
      finish(() =>
        reject(new Error(`signal-cli daemon closed the connection before answering "${method}"`)),
      );
    });
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function createSignalClient(options: SignalClientOptions): SignalClient {
  const account = options.account;
  const withAccount = (params: Record<string, unknown>): Record<string, unknown> => ({
    account,
    ...params,
  });
  const targetParams = (target: SendTarget): Record<string, unknown> =>
    "groupId" in target ? { groupId: target.groupId } : { recipient: [target.recipient] };

  return {
    account,
    async send(target, message, attachments) {
      const result = await rpcCall(
        options,
        "send",
        withAccount({
          ...targetParams(target),
          message,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      );
      return (result ?? {}) as { timestamp?: number } & Record<string, unknown>;
    },
    async sendReaction({ target, emoji, targetAuthor, targetTimestamp, remove }) {
      const result = await rpcCall(
        options,
        "sendReaction",
        withAccount({
          ...targetParams(target),
          emoji,
          targetAuthor,
          targetTimestamp,
          ...(remove ? { remove: true } : {}),
        }),
      );
      return (result ?? {}) as Record<string, unknown>;
    },
    async listContacts() {
      const result = await rpcCall(options, "listContacts", withAccount({}));
      return asArray(result) as Contact[];
    },
    async listGroups() {
      const result = await rpcCall(options, "listGroups", withAccount({}));
      return asArray(result) as Group[];
    },
    rpc(method, params) {
      return rpcCall(options, method, withAccount(params));
    },
  };
}

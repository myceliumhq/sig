import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AnyAgentTool } from "./agent-tool.js";
import { MessageStore } from "./ingest/store.js";
import { MAX_CONVERSATIONS_LIMIT, MAX_MESSAGES_LIMIT, MAX_SEARCH_LIMIT } from "./limits.js";
import { readSemanticSearchConfig, requireEnv } from "./mcp-server-config.js";
import { resolveAttachmentsDir, resolveDbPath, resolveSocketPath } from "./paths.js";
import { createSemanticSearchCore, type Logger } from "./semantic/handle.js";
import { readServerConfig, type ServerConfig } from "./server-config.js";
import { createSignalClient, SignalRpcError } from "./signal-client.js";
import { createListContactsTool, createListGroupsTool } from "./tools/directory.js";
import {
  createListAttachmentsTool,
  createListConversationsTool,
  createListMessagesTool,
  createSearchMessagesTool,
} from "./tools/messages.js";
import { createSendMessageTool, createSendReactionTool } from "./tools/messaging.js";

// sig-server: a plain bearer-token-gated JSON HTTP API frontend for sig,
// meant to run co-located with `sig daemon` (same host, same socket/store) so
// the `sig` CLI can be driven from a *different* machine (SIG_SERVER_URL +
// SIG_SERVER_TOKEN) instead of needing local access to the daemon's Unix
// socket and SQLite file. This is NOT MCP framing -- no JSON-RPC envelope,
// just normal REST-ish request/response -- and it does NOT replace the
// standalone MCP server, which keeps working unchanged. It DOES become the
// only way the `sig` CLI itself reaches a Signal account: every CLI command
// except `sig daemon` (which alone still owns the signal-cli child process
// directly) is a thin HTTP client against this server -- see src/cli/client.ts.
//
// Every route below reuses the exact same tool factories the MCP server
// wires (src/tools/*.ts) so validation, read-only filtering conventions, and
// business logic live in exactly one place. A random uuid stands in for the
// toolCallId those factories expect (an HTTP caller has none).

function stderrLogger(): Logger {
  const line = (level: string, message: string) =>
    console.error(`[sig-server] ${level} ${message}`);
  return {
    info: (message) => line("INFO", message),
    warn: (message) => line("WARN", message),
    error: (message) => line("ERROR", message),
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

// Every tool call funnels through here so the three failure shapes a tool
// execute() can throw map onto stable HTTP statuses the CLI's HTTP client
// (src/cli/client.ts) turns back into this app's EXIT_CODES contract:
//   * SignalRpcError (signal-cli itself rejected the request, e.g. unknown
//     recipient) -> 422, mirrors the old local-mode runRpc's mapping to
//     exit 1.
//   * socket unreachable/timeout (the daemon isn't running/answering) -> 503,
//     mirrors that same mapping to exit 4 with a `sig daemon` fix hint.
//   * anything else (a tool's own input validation, e.g. a bad E.164) -> 400.
function handleToolError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  if (err instanceof SignalRpcError) {
    sendJson(res, 422, { error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot reach signal-cli daemon socket|timed out after \d+ms/.test(message)) {
    sendJson(res, 503, { error: message });
    return;
  }
  sendJson(res, 400, { error: message });
}

async function runTool(res: ServerResponse, tool: AnyAgentTool, params: unknown): Promise<void> {
  try {
    const result = await tool.execute(randomUUID(), params);
    sendJson(res, 200, result.details);
  } catch (err) {
    handleToolError(res, err);
  }
}

function parseBoundedIntParam(
  raw: string | null,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${flag} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `invalid JSON body: ${message}`);
  }
}

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type Deps = {
  store: MessageStore;
  tools: {
    contacts: AnyAgentTool;
    groups: AnyAgentTool;
    conversations: AnyAgentTool;
    messages: AnyAgentTool;
    attachments: AnyAgentTool;
    search: AnyAgentTool;
    react: AnyAgentTool;
    send: AnyAgentTool;
  };
  config: ServerConfig;
  account: string;
};

function requireAuth(req: IncomingMessage, config: ServerConfig): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return match[1] === config.token;
}

function streamAttachmentContent(res: ServerResponse, store: MessageStore, id: string): void {
  const row = store.getAttachmentById(id);
  if (!row || !existsSync(row.localPath)) {
    sendJson(res, 404, { error: `attachment not found: ${id}` });
    return;
  }
  const contentType = row.contentType ?? "application/octet-stream";
  const fileName = (row.fileName ?? id).replace(/"/g, "");
  res.writeHead(200, {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${fileName}"`,
  });
  const stream = createReadStream(row.localPath);
  stream.on("error", () => {
    if (!res.headersSent) sendJson(res, 404, { error: `attachment file unreadable: ${id}` });
    else res.destroy();
  });
  stream.pipe(res);
}

async function handleSend(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  if (deps.config.readOnly) {
    sendJson(res, 403, { error: "read-only mode: sends are disabled" });
    return;
  }
  const contentType = req.headers["content-type"];
  const bodyBuf = await readRequestBuffer(req);
  let form: FormData;
  try {
    const webRequest = new Request("http://sig-server.internal/v1/send", {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body: bodyBuf,
    });
    form = await webRequest.formData();
  } catch {
    sendJson(res, 400, { error: "expected multipart/form-data body" });
    return;
  }

  const recipient = form.get("recipient");
  const groupId = form.get("group_id");
  const message = form.get("message");
  const replyToTsRaw = form.get("reply_to_ts");
  const replyToAuthor = form.get("reply_to_author");
  // Staged under sig's own persistent attachments dir (same one received
  // attachments are copied into, see paths.ts's resolveAttachmentsDir), NOT
  // a cleaned-up os.tmpdir() path: outgoingAttachmentRows() (ingest/parse.ts)
  // records whatever path we pass here as the attachment's permanent
  // local_path, so it must still resolve on disk whenever a later
  // GET /v1/attachments/:id/content is served -- these bytes are never
  // deleted after the send completes. Each upload gets its own uuid
  // subdirectory so the stored path's basename is exactly the original
  // filename (outgoingAttachmentRows derives file_name from that basename).
  const stagedPaths: string[] = [];
  try {
    for (const value of form.getAll("attachment")) {
      if (!(value instanceof File)) continue;
      const stagedDir = join(resolveAttachmentsDir(), "sent", randomUUID());
      await mkdir(stagedDir, { recursive: true });
      const stagedPath = join(stagedDir, value.name || "attachment");
      await writeFile(stagedPath, Buffer.from(await value.arrayBuffer()));
      stagedPaths.push(stagedPath);
    }
    let replyToTs: number | undefined;
    if (typeof replyToTsRaw === "string" && replyToTsRaw !== "") {
      const n = Number(replyToTsRaw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new HttpError(400, `reply_to_ts must be a positive integer (got "${replyToTsRaw}")`);
      }
      replyToTs = n;
    }
    const result = await deps.tools.send.execute(randomUUID(), {
      recipient: typeof recipient === "string" && recipient !== "" ? recipient : undefined,
      group_id: typeof groupId === "string" && groupId !== "" ? groupId : undefined,
      message: typeof message === "string" ? message : "",
      attachments: stagedPaths,
      reply_to_ts: replyToTs,
      reply_to_author:
        typeof replyToAuthor === "string" && replyToAuthor !== "" ? replyToAuthor : undefined,
    });
    sendJson(res, 200, result.details);
  } catch (err) {
    handleToolError(res, err);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://sig-server.internal");
  const method = req.method ?? "GET";
  const pathname = url.pathname;
  const attachmentContentMatch = /^\/v1\/attachments\/([^/]+)\/content$/.exec(pathname);

  if (method === "GET" && pathname === "/v1/health") {
    sendJson(res, 200, { ok: true, account: deps.account, read_only: deps.config.readOnly });
    return;
  }

  if (method === "GET" && pathname === "/v1/contacts") {
    await runTool(res, deps.tools.contacts, {});
    return;
  }

  if (method === "GET" && pathname === "/v1/groups") {
    await runTool(res, deps.tools.groups, {});
    return;
  }

  if (method === "GET" && pathname === "/v1/conversations") {
    try {
      const limit = parseBoundedIntParam(
        url.searchParams.get("limit"),
        "limit",
        1,
        MAX_CONVERSATIONS_LIMIT,
      );
      await runTool(res, deps.tools.conversations, { limit });
    } catch (err) {
      handleToolError(res, err);
    }
    return;
  }

  if (method === "GET" && pathname === "/v1/messages") {
    try {
      const limit = parseBoundedIntParam(
        url.searchParams.get("limit"),
        "limit",
        1,
        MAX_MESSAGES_LIMIT,
      );
      await runTool(res, deps.tools.messages, {
        sender: url.searchParams.get("sender") ?? undefined,
        group_id: url.searchParams.get("group_id") ?? undefined,
        limit,
      });
    } catch (err) {
      handleToolError(res, err);
    }
    return;
  }

  if (method === "GET" && pathname === "/v1/search") {
    try {
      const query = url.searchParams.get("query");
      if (!query) throw new HttpError(400, "query is required");
      const limit = parseBoundedIntParam(
        url.searchParams.get("limit"),
        "limit",
        1,
        MAX_SEARCH_LIMIT,
      );
      await runTool(res, deps.tools.search, { query, limit });
    } catch (err) {
      handleToolError(res, err);
    }
    return;
  }

  if (method === "GET" && pathname === "/v1/attachments") {
    try {
      const tsRaw = url.searchParams.get("ts");
      if (!tsRaw) throw new HttpError(400, "ts is required");
      const ts = parseBoundedIntParam(tsRaw, "ts", 1, Number.MAX_SAFE_INTEGER);
      await runTool(res, deps.tools.attachments, {
        ts,
        sender: url.searchParams.get("sender") ?? undefined,
        group_id: url.searchParams.get("group_id") ?? undefined,
      });
    } catch (err) {
      handleToolError(res, err);
    }
    return;
  }

  if (method === "GET" && attachmentContentMatch) {
    streamAttachmentContent(
      res,
      deps.store,
      decodeURIComponent(attachmentContentMatch[1] as string),
    );
    return;
  }

  if (method === "POST" && pathname === "/v1/react") {
    if (deps.config.readOnly) {
      sendJson(res, 403, { error: "read-only mode: reactions are disabled" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      await runTool(res, deps.tools.react, {
        recipient: body.recipient,
        group_id: body.group_id,
        emoji: body.emoji,
        target_author: body.target_author,
        target_timestamp: body.target_timestamp,
        remove: body.remove,
      });
    } catch (err) {
      handleToolError(res, err);
    }
    return;
  }

  if (method === "POST" && pathname === "/v1/send") {
    await handleSend(req, res, deps);
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${pathname}` });
}

async function main(): Promise<void> {
  const logger = stderrLogger();
  const config = readServerConfig(process.env);
  const account = requireEnv(process.env, "SIGNAL_ACCOUNT");
  const semanticSearchConfig = readSemanticSearchConfig(process.env);

  const store = new MessageStore(resolveDbPath());
  const client = createSignalClient({ socketPath: resolveSocketPath(), account });
  const semantic = createSemanticSearchCore({ config: semanticSearchConfig, logger });

  const tools = {
    contacts: createListContactsTool(client),
    groups: createListGroupsTool(client),
    conversations: createListConversationsTool(store),
    messages: createListMessagesTool(store),
    attachments: createListAttachmentsTool(store),
    search: createSearchMessagesTool(store, semantic),
    react: createSendReactionTool(client),
    send: createSendMessageTool(client, store),
  };

  const deps: Deps = { store, tools, config, account };

  const server = http.createServer((req, res) => {
    if (!requireAuth(req, config)) {
      sendJson(res, 401, { error: "missing or invalid bearer token" });
      return;
    }
    route(req, res, deps).catch((err) => {
      logger.error?.(err instanceof Error ? (err.stack ?? err.message) : String(err));
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info?.(
    `listening on ${config.host}:${config.port} (read-only ${config.readOnly ? "ON" : "off"})`,
  );
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    logger.warn?.(
      `binding on non-loopback interface ${config.host}: this is fine ONLY behind a reverse proxy ` +
        "that itself terminates the network exposure -- every request still requires the configured " +
        "bearer token, but there is no rate limiting or TLS here",
    );
  }

  const shutdown = async (signal: string) => {
    logger.info?.(`received ${signal}, shutting down`);
    await semantic.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

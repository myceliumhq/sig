import { createRequire } from "node:module";
import {
  type BridgeableTool,
  createMcpServer,
  type HttpServerHandle,
  serveHttp,
  serveStdio,
} from "@myceliumhq/mcp";
import type { AnyAgentTool } from "./agent-tool.js";
import { MessageStore } from "./ingest/store.js";
import { isLoopbackHost, readStandaloneConfig, readTransportConfig } from "./mcp-server-config.js";
import { resolveDbPath, resolveSocketPath } from "./paths.js";
import { createSemanticSearchCore, type Logger } from "./semantic/handle.js";
import { createSignalClient } from "./signal-client.js";
import {
  createListContactsTool,
  createListGroupsTool,
  createWhoamiTool,
} from "./tools/directory.js";
import {
  createListAttachmentsTool,
  createListConversationsTool,
  createListMessagesTool,
  createSearchMessagesTool,
} from "./tools/messages.js";
import { createSendMessageTool, createSendReactionTool } from "./tools/messaging.js";
import { filterReadOnlyTools } from "./tools/read-only.js";

// MCP's stdio transport uses stdout exclusively for JSON-RPC framing --
// anything else there corrupts the stream. Every log line goes to stderr.
function stderrLogger(): Logger {
  const line = (level: string, message: string) =>
    console.error(`[signal-mcp] ${level} ${message}`);
  return {
    info: (message) => line("INFO", message),
    warn: (message) => line("WARN", message),
    error: (message) => line("ERROR", message),
  };
}

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  return pkg.version;
}

// The complete MCP tool surface -- extracted from main() so a test can import
// it (with stub deps) and assert against it without main()'s process-level side
// effects. Also the drift-detection source of truth for tools/read-only.ts:
// every name here must be classified as read-only or write, and vice versa.
export function createAllTools(deps: {
  client: ReturnType<typeof createSignalClient>;
  store: MessageStore;
  semantic: ReturnType<typeof createSemanticSearchCore>;
  account: string;
  readOnly: boolean;
}): AnyAgentTool[] {
  return [
    createSearchMessagesTool(deps.store, deps.semantic),
    createListConversationsTool(deps.store),
    createListMessagesTool(deps.store),
    createListAttachmentsTool(deps.store),
    createListContactsTool(deps.client),
    createListGroupsTool(deps.client),
    createWhoamiTool(deps.account, deps.readOnly),
    createSendMessageTool(deps.client, deps.store),
    createSendReactionTool(deps.client),
  ];
}

async function main(): Promise<void> {
  const logger = stderrLogger();
  const config = readStandaloneConfig(process.env);

  // The MCP server is read-side + command-side only: it reads the SQLite store
  // the `sig daemon` process writes, and issues JSON-RPC to that daemon's
  // socket for sends. It never runs the receiver itself.
  const store = new MessageStore(resolveDbPath());
  const client = createSignalClient({
    socketPath: resolveSocketPath(),
    account: config.account,
  });
  const semantic = createSemanticSearchCore({ config: config.semanticSearch, logger });

  const allTools = createAllTools({
    client,
    store,
    semantic,
    account: config.account,
    readOnly: config.readOnly,
  });

  // SIGNAL_READ_ONLY=true is a hard trim: the write tools are never handed to
  // createMcpServer, so they never appear in tools/list and there's no handler
  // behind them to call.
  const tools = filterReadOnlyTools(allTools, config.readOnly);
  logger.info?.(
    `read-only mode ${config.readOnly ? "ON" : "off"}: registering ${tools.length} of ${allTools.length} tools`,
  );

  const transportConfig = readTransportConfig(process.env);
  if (transportConfig.transport === "http" && !isLoopbackHost(transportConfig.host)) {
    logger.warn?.(
      `binding on non-loopback interface ${transportConfig.host}: the app has no built-in auth; ` +
        "only expose behind an authenticated reverse proxy and prefer read-only mode",
    );
  }

  let httpHandle: HttpServerHandle | undefined;
  if (transportConfig.transport === "http") {
    httpHandle = await serveHttp(
      () =>
        createMcpServer(tools as unknown as BridgeableTool[], {
          name: "signal",
          version: packageVersion(),
        }),
      {
        port: transportConfig.port,
        host: transportConfig.host,
        allowedHosts: transportConfig.allowedHosts,
      },
    );
    logger.info?.(`listening on ${httpHandle.host}:${httpHandle.port}/mcp`);
  } else {
    const server = createMcpServer(tools as unknown as BridgeableTool[], {
      name: "signal",
      version: packageVersion(),
    });
    await serveStdio(server);
    logger.info?.("listening on stdio");
  }

  const shutdown = async (signal: string) => {
    logger.info?.(`received ${signal}, shutting down`);
    await semantic.dispose();
    await httpHandle?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only run main() when executed directly (node dist/mcp-server.js), not when
// imported for createAllTools -- read-only.test.ts imports this to get the real
// tool list without booting a server or parsing env vars.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

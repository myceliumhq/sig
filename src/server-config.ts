import { parseBindHost, parsePortEnv, readReadOnlyFlag, requireEnv } from "./mcp-server-config.js";

// Env-var parsing for sig-server (src/server.ts), kept separate and testable
// the same way mcp-server-config.ts is for the MCP server. Reuses that
// module's env-parsing primitives (docker-secret _FILE convention, strict
// port/host/bool parsing) rather than re-implementing them.

export type ServerConfig = {
  port: number;
  host: string;
  // The single bearer token every request must present via
  // `Authorization: Bearer <token>`. Unlike the MCP server's loopback-vs-
  // non-loopback distinction, sig-server's entire purpose is being reached
  // remotely -- there is no auth-free path, so this is always required.
  token: string;
  readOnly: boolean;
};

const DEFAULT_PORT = 8420;
const DEFAULT_HOST = "127.0.0.1";

export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: parsePortEnv(env, "SIG_SERVER_PORT", DEFAULT_PORT),
    host: parseBindHost(env, "SIG_SERVER_HOST", DEFAULT_HOST),
    // SIG_SERVER_TOKEN / SIG_SERVER_TOKEN_FILE -- refuse to start without one.
    token: requireEnv(env, "SIG_SERVER_TOKEN"),
    // Same semantics as the MCP server's SIGNAL_READ_ONLY, applied to
    // sig-server's write endpoints (POST /v1/react, POST /v1/send) instead of
    // a tool list.
    readOnly: readReadOnlyFlag(env, "SIG_READ_ONLY"),
  };
}

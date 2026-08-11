import { readFileSync } from "node:fs";
import type { SemanticSearchPluginConfig } from "./semantic/handle.js";

export type StandaloneConfig = {
  account: string;
  semanticSearch: SemanticSearchPluginConfig | undefined;
  readOnly: boolean;
};

export type TransportConfig =
  | { transport: "stdio" }
  | {
      transport: "http";
      port: number;
      host: string;
      allowedHosts?: string[];
    };

// Docker-secret convention: <NAME>_FILE points at a file whose trimmed contents
// are the value (trimming drops the trailing newline such files carry).
// Exported: src/server-config.ts and src/cli/config.ts reuse this exact
// convention for SIG_SERVER_TOKEN/SIG_SERVER_TOKEN_FILE, so there's exactly
// one implementation of the docker-secret pattern in the app.
export function readEnvOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  return filePath ? readFileSync(filePath, "utf8").trim() : env[name];
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readEnvOrFile(env, name);
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// Strict boolean env flag: only "true"/"false" accepted. Unset/empty yields
// undefined (a Docker/k8s artifact must stay inert); any other value throws.
function parseBoolEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false" (got "${raw}")`);
}

// Exported for src/server-config.ts (SIG_SERVER_PORT).
export function parsePortEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return parsed;
}

// Exported for src/server-config.ts (SIG_SERVER_HOST).
export function parseBindHost(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (/\s/.test(value)) {
    throw new Error(`${name} must be a host/IP without whitespace (got ${JSON.stringify(raw)})`);
  }
  return value;
}

function parseHostList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const entries = raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (entries.length === 0) return undefined;
  for (const entry of entries) {
    if (
      /\s/.test(entry) ||
      entry.includes("://") ||
      entry.includes("/") ||
      /^[^:\s]+:\d+$/.test(entry)
    ) {
      throw new Error(
        `${name} contains an invalid host entry ${JSON.stringify(entry)} ` +
          "(expected a bare hostname/IP, no scheme, path, port, or whitespace)",
      );
    }
  }
  return Array.from(new Set(entries));
}

// Only loopback interfaces are safe to bind unauthenticated (core/mcp's default
// Host allowlist uses the same set). Case-insensitive to match its Host-header
// normalization.
export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

// Exported: src/server.ts wires the same sig-semanticd sidecar config the
// standalone MCP server does, off the same SIGNAL_SEMANTICD_URL /
// SIGNAL_SEMANTIC_SEARCH_ENABLED env vars.
export function readSemanticSearchConfig(
  env: NodeJS.ProcessEnv,
): SemanticSearchPluginConfig | undefined {
  const enabled = parseBoolEnv(env, "SIGNAL_SEMANTIC_SEARCH_ENABLED");
  if (enabled === false) {
    return { enabled: false };
  }
  const semanticdUrl = env.SIGNAL_SEMANTICD_URL;
  if (!semanticdUrl) return undefined;
  return { semanticdUrl };
}

export function readStandaloneConfig(env: NodeJS.ProcessEnv): StandaloneConfig {
  return {
    account: requireEnv(env, "SIGNAL_ACCOUNT"),
    semanticSearch: readSemanticSearchConfig(env),
    readOnly: readReadOnlyFlag(env, "SIGNAL_READ_ONLY"),
  };
}

// Read-only armed only by the literal "true". A non-empty unrecognized value is
// a startup error rather than a silent read-write default -- failing closed on a
// typo'd security switch aimed at HTTP exposure. Empty/unset is "off" (opt-in).
// Exported: src/server-config.ts applies the exact same semantics to
// SIG_READ_ONLY.
export function readReadOnlyFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly "true" or empty, got ${JSON.stringify(value)}`);
}

export function readTransportConfig(env: NodeJS.ProcessEnv): TransportConfig {
  const transport = env.MCP_TRANSPORT;
  if (transport === "http") {
    const host = parseBindHost(env, "MCP_HOST", "127.0.0.1");
    const allowedHosts = parseHostList(env, "MCP_ALLOWED_HOSTS");
    if (!isLoopbackHost(host) && allowedHosts === undefined) {
      throw new Error(
        `MCP_HOST is bound to non-loopback interface "${host}" but MCP_ALLOWED_HOSTS is not set ` +
          "(the app has no built-in auth)",
      );
    }
    return {
      transport: "http",
      port: parsePortEnv(env, "MCP_PORT", 3000),
      host,
      allowedHosts,
    };
  }
  if (transport !== undefined && transport !== "" && transport !== "stdio") {
    throw new Error(`Unknown MCP_TRANSPORT value "${transport}" (expected "stdio" or "http")`);
  }
  return { transport: "stdio" };
}

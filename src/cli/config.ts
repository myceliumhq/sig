import { CliError, EXIT_CODES, requireConfig } from "@myceliumhq/toolkit";
import { readEnvOrFile } from "../mcp-server-config.js";
import { createSigServerClient, type SigServerClient } from "./client.js";

export const CONFIG_SPEC = {
  account: {
    env: "SIGNAL_ACCOUNT",
    description: "Your linked Signal phone number in E.164 format (e.g. +491700000000).",
  },
} as const;

// Only `sig daemon` needs this -- it's the sole command left that owns the
// signal-cli child process directly. Every other command talks to sig-server
// over HTTP (resolveClient() below) and never needs SIGNAL_ACCOUNT itself.
export function resolveAccount(): string {
  return requireConfig(CONFIG_SPEC).account;
}

export type ServerConnection = { baseUrl: string; token: string };

// Resolved lazily (not at module load) so `sig --help` never requires these
// env vars just to print usage. Every non-daemon command requires both --
// there is no fallback to local socket/SQLite access; sig-server is the only
// way this CLI reaches a Signal account.
export function resolveServerConnection(): ServerConnection {
  const url = process.env.SIG_SERVER_URL;
  if (!url || url.trim() === "") {
    throw new CliError("SIG_SERVER_URL is not set", {
      exitCode: EXIT_CODES.config,
      fix:
        "set SIG_SERVER_URL to your sig-server's base URL (e.g. https://sig.example.internal) and " +
        "SIG_SERVER_TOKEN to its configured bearer token",
    });
  }
  const token = readEnvOrFile(process.env, "SIG_SERVER_TOKEN");
  if (!token) {
    throw new CliError("SIG_SERVER_TOKEN (or SIG_SERVER_TOKEN_FILE) is not set", {
      exitCode: EXIT_CODES.config,
      fix: "set SIG_SERVER_TOKEN to the sig-server's configured bearer token",
    });
  }
  return { baseUrl: url.trim().replace(/\/+$/, ""), token };
}

export function resolveClient(): SigServerClient {
  const { baseUrl, token } = resolveServerConnection();
  return createSigServerClient({ baseUrl, token });
}

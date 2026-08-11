import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Signal-specific path resolution. Two independent locations, deliberately
// kept apart:
//
//   * the SQLite message store -- normal app state-dir convention
//     ($XDG_STATE_HOME/sig, ~/.local/state/sig), can live under a long path.
//   * the signal-cli JSON-RPC Unix socket -- MUST stay short. AF_UNIX caps a
//     socket path at ~104 bytes on macOS / ~108 on Linux, and putting the
//     socket under the (long) state dir blows past that limit and makes the
//     daemon exit immediately. Live-verified. So the socket goes under
//     $XDG_RUNTIME_DIR/sig (a short, tmpfs-backed path on Linux) with a short
//     /tmp fallback when that's unset.

const APP = "sig";

// State dir for the message DB: $XDG_STATE_HOME/sig, else ~/.local/state/sig.
export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "state");
  return join(base, APP);
}

// Resolve the SQLite store path. SIGNAL_DB overrides; otherwise it's
// <stateDir>/messages.db. Ensures the parent directory exists.
export function resolveDbPath(): string {
  const override = process.env.SIGNAL_DB;
  const path = override && override.trim() !== "" ? override : join(stateDir(), "messages.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

// Resolve the Unix socket path, keeping it short (see the AF_UNIX note above).
// SIGNAL_SOCKET overrides; otherwise $XDG_RUNTIME_DIR/sig/signal-cli.sock, and
// if XDG_RUNTIME_DIR is unset a short per-uid path under the OS temp dir.
// Ensures the parent directory exists.
export function resolveSocketPath(): string {
  const override = process.env.SIGNAL_SOCKET;
  if (override && override.trim() !== "") {
    mkdirSync(dirname(override), { recursive: true });
    return override;
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && runtime.trim() !== "" ? join(runtime, APP) : join(tmpdir(), APP);
  mkdirSync(base, { recursive: true });
  return join(base, "signal-cli.sock");
}

// signal-cli config/data dir. Unset lets signal-cli use its own default
// (~/.local/share/signal-cli) -- we simply don't pass --config in that case.
export function resolveConfigDir(): string | undefined {
  const dir = process.env.SIGNAL_CONFIG_DIR;
  return dir && dir.trim() !== "" ? dir : undefined;
}

// Same as resolveConfigDir(), but always returns a real path by mirroring
// signal-cli's own default ($XDG_DATA_HOME/signal-cli, else
// ~/.local/share/signal-cli) when SIGNAL_CONFIG_DIR is unset. Needed only by
// the ingestion daemon, to find signal-cli's on-disk `attachments/` dir
// (where it downloads received attachment bytes) even when we never passed
// --config and let signal-cli pick its own default location.
export function resolveEffectiveConfigDir(): string {
  const override = resolveConfigDir();
  if (override) return override;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share");
  return join(base, "signal-cli");
}

// Where sig copies received attachment bytes on ingest, so every other
// command only ever needs SIGNAL_DB (not SIGNAL_CONFIG_DIR) to read them --
// same decoupling as the message store itself. SIGNAL_ATTACHMENTS_DIR
// overrides; otherwise <stateDir>/attachments.
export function resolveAttachmentsDir(): string {
  const override = process.env.SIGNAL_ATTACHMENTS_DIR;
  const dir = override && override.trim() !== "" ? override : join(stateDir(), "attachments");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Path to the signal-cli binary. Defaults to `signal-cli` on PATH.
export function resolveSignalCliPath(): string {
  const p = process.env.SIGNAL_CLI_PATH;
  return p && p.trim() !== "" ? p : "signal-cli";
}

const DEFAULT_MAX_STORED = 100_000;

// Storage growth cap for MessageStore (mirrors the retired signal-mcp-server
// prototype's SIGNAL_MCP_MAX_STORED). SIGNAL_MAX_STORED overrides; must be a
// positive integer or the default (100,000) is used silently -- a malformed
// value here shouldn't crash the daemon over something this low-stakes.
export function resolveMaxStored(): number {
  const raw = process.env.SIGNAL_MAX_STORED;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_MAX_STORED;
}

// Heartbeat file `sig daemon` touches with an RFC3339 timestamp so an
// external watchdog (e.g. a homelab uptime monitor) can check the process is
// alive and processing -- see ingest/daemon.ts for the honesty caveat (an
// activity marker, not a liveness proof). Lives in the state dir alongside
// the DB by default; SIGNAL_HEARTBEAT_PATH overrides.
export function resolveHeartbeatPath(): string {
  const override = process.env.SIGNAL_HEARTBEAT_PATH;
  const path = override && override.trim() !== "" ? override : join(stateDir(), "HEARTBEAT");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

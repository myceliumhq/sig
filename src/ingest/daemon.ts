import { spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  resolveAttachmentsDir,
  resolveConfigDir,
  resolveDbPath,
  resolveEffectiveConfigDir,
  resolveHeartbeatPath,
  resolveSignalCliPath,
  resolveSocketPath,
} from "../paths.js";
import type { AttachmentRow, Attachment as ParsedAttachment, StoredRow } from "./parse.js";
import { parseLine, toRemoteDelete, toStoredRow } from "./parse.js";
import { MessageStore } from "./store.js";

// The ingestion supervisor. This is the core new subsystem versus ppl/tri: sig
// OWNS the signal-cli process rather than talking to an already-running
// external daemon. We spawn `signal-cli -o json ... daemon --socket <path>
// --receive-mode on-start`, which (a) exposes JSON-RPC over the Unix socket for
// commands (see signal-client.ts) and (b) prints every received envelope to
// stdout the instant it arrives. Because we are the sole owner, we are always
// the sole *receiver* -- structurally sidestepping the one-active-receiver-
// per-account bug that made the retired external-poller prototype silently drop
// inbound messages (see AGENTS.md).
//
// Messages missed while this is down are NOT lost: signal-cli's server-side
// queue holds them and delivers on the next start (empirically validated).
// This process is meant to run continuously -- start it once (e.g. a systemd
// user unit; see README) and leave it up. Everything else in the app just
// reads the SQLite store it writes, plus issues commands to the same socket.

export type DaemonLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function stderrDaemonLogger(): DaemonLogger {
  const line = (level: string, message: string) =>
    process.stderr.write(`[sig daemon] ${level} ${message}\n`);
  return {
    info: (m) => line("INFO", m),
    warn: (m) => line("WARN", m),
    error: (m) => line("ERROR", m),
  };
}

export interface DaemonConfig {
  account: string;
  signalCliPath: string;
  configDir: string | undefined;
  socketPath: string;
  dbPath: string;
  // Where signal-cli itself downloads received attachment bytes (its own
  // config/data dir's "attachments" subfolder -- resolved with the same
  // default-mirroring logic as signal-cli itself, even when configDir above
  // is undefined because we never passed --config).
  attachmentsSourceDir: string;
  // Where sig copies them to, so every other command only ever needs
  // SIGNAL_DB (see paths.ts resolveAttachmentsDir).
  attachmentsDestDir: string;
  // Plain-text RFC3339 timestamp file an external watchdog can poll -- see
  // the HEARTBEAT-writing logic below for exactly what it does/doesn't prove.
  heartbeatPath: string;
}

export function resolveDaemonConfig(account: string): DaemonConfig {
  return {
    account,
    signalCliPath: resolveSignalCliPath(),
    configDir: resolveConfigDir(),
    socketPath: resolveSocketPath(),
    dbPath: resolveDbPath(),
    attachmentsSourceDir: join(resolveEffectiveConfigDir(), "attachments"),
    attachmentsDestDir: resolveAttachmentsDir(),
    heartbeatPath: resolveHeartbeatPath(),
  };
}

// At most once a minute, matching wacli's own rate limit -- this is an
// ACTIVITY marker, not a liveness proof: a healthy-but-quiet session (no
// incoming envelopes for a while) still touches it via the timer below, but
// a genuinely wedged signal-cli process that stopped emitting stdout at all
// AND whose timer got starved (e.g. the whole event loop is blocked) would
// stop updating it too -- a watchdog should treat a stale file as "worth
// investigating", not as gospel proof of a hang.
const HEARTBEAT_INTERVAL_MS = 60_000;

function createHeartbeat(path: string): { touch: (force?: boolean) => void; stop: () => void } {
  let lastWriteMs = 0;
  const write = () => {
    lastWriteMs = Date.now();
    try {
      writeFileSync(path, `${new Date(lastWriteMs).toISOString()}\n`);
    } catch {
      // Best-effort -- an unwritable heartbeat path shouldn't crash ingestion.
    }
  };
  write(); // initial touch on startup, so a watchdog sees freshness immediately
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    touch: (force = false) => {
      if (force || Date.now() - lastWriteMs >= HEARTBEAT_INTERVAL_MS) write();
    },
    stop: () => clearInterval(timer),
  };
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A run that survived at least this long is treated as "healthy" and resets the
// restart backoff -- so a genuinely working daemon that happens to be restarted
// (e.g. host suspend) doesn't accumulate multi-minute delays, while a
// crash-looping one still backs off.
const HEALTHY_RUN_MS = 60_000;

function buildArgs(config: DaemonConfig): string[] {
  const args = ["-o", "json"];
  if (config.configDir) args.push("--config", config.configDir);
  args.push("-a", config.account);
  args.push("daemon", "--socket", config.socketPath, "--receive-mode", "on-start");
  return args;
}

export interface RunDaemonOptions {
  logger?: DaemonLogger;
  // Test seam: injectable store. Defaults to the real SQLite store.
  store?: MessageStore;
  // Resolves when the supervisor should stop (e.g. wired to SIGINT/SIGTERM).
  signal?: AbortSignal;
}

// Run the supervisor loop forever (until aborted). Spawns signal-cli, tails its
// stdout into the store, and restarts on crash with exponential backoff.
export async function runIngestionDaemon(
  config: DaemonConfig,
  options: RunDaemonOptions = {},
): Promise<void> {
  const logger = options.logger ?? stderrDaemonLogger();
  const store = options.store ?? new MessageStore(config.dbPath);
  let backoff = BACKOFF_MIN_MS;
  const heartbeat = createHeartbeat(config.heartbeatPath);

  logger.info(
    `store ${config.dbPath} (${store.count()} rows, cap ${store.maxStoredCap} -- see SIGNAL_MAX_STORED), ` +
      `socket ${config.socketPath}, account ${config.account}, heartbeat ${config.heartbeatPath}`,
  );

  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    try {
      await runOnce(config, store, logger, options.signal, heartbeat);
    } catch (err) {
      logger.error(`signal-cli supervision error: ${describe(err)}`);
    }
    if (options.signal?.aborted) break;

    const ranFor = Date.now() - startedAt;
    if (ranFor >= HEALTHY_RUN_MS) backoff = BACKOFF_MIN_MS;
    logger.warn(
      `signal-cli exited (ran ${Math.round(ranFor / 1000)}s); restarting in ${backoff}ms`,
    );
    await delay(backoff, options.signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  heartbeat.stop();
  logger.info("shutdown requested; stopping supervisor");
  if (!options.store) store.close();
}

// One spawn+tail lifecycle. Resolves when the child exits (for any reason);
// the caller decides whether to restart.
function runOnce(
  config: DaemonConfig,
  store: MessageStore,
  logger: DaemonLogger,
  signal: AbortSignal | undefined,
  heartbeat: { touch: (force?: boolean) => void; stop: () => void },
): Promise<void> {
  // A stale socket file from a previous unclean exit makes bind() fail; clear
  // it before starting (the daemon recreates it).
  if (existsSync(config.socketPath)) {
    try {
      rmSync(config.socketPath);
    } catch {
      // Best-effort -- if it's genuinely in use by a live daemon, the spawn
      // below will surface the real error.
    }
  }

  const child = spawn(config.signalCliPath, buildArgs(config), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let inserted = 0;
  let seen = 0;

  // With stdio ["ignore","pipe","pipe"], stdout/stderr are always present, but
  // the general spawn signature types them as nullable -- guard once.
  if (!child.stdout || !child.stderr) {
    return new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.kill("SIGTERM");
    });
  }

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const notification = parseLine(line);
    if (!notification) return;
    // Activity marker only (see createHeartbeat's doc comment) -- touch on
    // every real stdout line signal-cli emits, throttled internally to at
    // most once/minute.
    heartbeat.touch();

    // Remote-delete ("delete for everyone") events are handled as a
    // tombstone UPDATE, not an insert -- checked first so toStoredRow never
    // sees (and misclassifies) this notification shape at all.
    const remoteDelete = toRemoteDelete(notification);
    if (remoteDelete) {
      try {
        const affected = store.markDeleted(
          remoteDelete.source,
          remoteDelete.ts,
          remoteDelete.deletedAt,
        );
        logger.info(
          `remote delete for ${remoteDelete.source}:${remoteDelete.ts}` +
            (affected ? "" : " (original message not found locally -- no-op)"),
        );
      } catch (err) {
        logger.error(`failed to mark deleted: ${describe(err)}`);
      }
      return;
    }

    const row = toStoredRow(notification);
    if (!row) return;
    seen += 1;
    try {
      if (store.insert(row)) inserted += 1;
      if (row.rawAttachments.length > 0) {
        ingestAttachments(row, config, store, logger);
      }
    } catch (err) {
      logger.error(`failed to persist envelope: ${describe(err)}`);
    }
  });

  // signal-cli logs its own diagnostics to stderr -- forward them, prefixed, so
  // link/registration problems are visible without drowning the log.
  const stderrStream = child.stderr;
  const errRl = createInterface({ input: stderrStream });
  errRl.on("line", (line) => {
    if (line.trim() !== "") logger.warn(`signal-cli: ${line}`);
  });

  const onAbort = () => {
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  logger.info("signal-cli daemon started; receiving");

  return new Promise<void>((resolve) => {
    child.on("error", (err) => {
      logger.error(`failed to spawn ${config.signalCliPath}: ${err.message}`);
    });
    child.on("close", () => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      errRl.close();
      logger.info(`run ended: ${seen} envelopes seen, ${inserted} new rows stored`);
      resolve();
    });
  });
}

// Copy each attachment's bytes from signal-cli's own download location into
// sig's attachments dir, and record its metadata -- run once per received
// message that carries attachments, right after its message row lands.
// signal-cli downloads the file synchronously before emitting the `receive`
// notification on stdout, so the source file is already present by the time
// this runs (no separate wait/poll needed -- if it's genuinely missing,
// e.g. --ignore-attachments was set some other way, this just logs and skips
// that one attachment rather than failing the whole message).
function ingestAttachments(
  row: StoredRow,
  config: DaemonConfig,
  store: MessageStore,
  logger: DaemonLogger,
): void {
  for (const att of row.rawAttachments) {
    const id = att.id as string; // rawAttachmentsOf() already filtered to id !== undefined/""
    const srcPath = join(config.attachmentsSourceDir, id);
    const destPath = join(config.attachmentsDestDir, id);
    try {
      if (!existsSync(srcPath)) {
        logger.warn(`attachment ${id} not found at ${srcPath} (skipping)`);
        continue;
      }
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
      const inserted = store.insertAttachment(attachmentRow(row, att, destPath));
      if (inserted)
        logger.info(`ingested attachment ${id} (${att.fileName ?? att.contentType ?? "?"})`);
    } catch (err) {
      logger.error(`failed to copy attachment ${id}: ${describe(err)}`);
    }
  }
}

function attachmentRow(row: StoredRow, att: ParsedAttachment, localPath: string): AttachmentRow {
  return {
    id: att.id as string,
    source: row.source,
    ts: row.ts,
    fileName: att.fileName ?? null,
    contentType: att.contentType ?? null,
    size: att.size ?? null,
    localPath,
  };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

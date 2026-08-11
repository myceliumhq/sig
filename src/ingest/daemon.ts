import { spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  resolveAttachmentsDir,
  resolveConfigDir,
  resolveDbPath,
  resolveEffectiveConfigDir,
  resolveSignalCliPath,
  resolveSocketPath,
} from "../paths.js";
import type { AttachmentRow, Attachment as ParsedAttachment, StoredRow } from "./parse.js";
import { parseLine, toStoredRow } from "./parse.js";
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

  logger.info(
    `store ${config.dbPath} (${store.count()} rows), socket ${config.socketPath}, account ${config.account}`,
  );

  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    try {
      await runOnce(config, store, logger, options.signal);
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

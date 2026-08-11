import { addSubcommand, type Command } from "@myceliumhq/toolkit";
import { resolveDaemonConfig, runIngestionDaemon } from "../../ingest/daemon.js";
import { resolveAccount } from "../config.js";

export function registerDaemon(program: Command): void {
  addSubcommand(program, "daemon")
    .summary(
      "Run the ingestion supervisor: own signal-cli and tail received messages into the store.",
    )
    .description(
      "Long-lived. Spawns and supervises the signal-cli daemon (auto-restarting it with backoff on " +
        "crash), reads every received envelope off its stdout in real time, and persists it to the " +
        "local SQLite store that every other command reads. Because sig owns the process it is " +
        "always the sole receiver -- no external poller to race, no dropped messages. Also exposes " +
        "the JSON-RPC socket the send/react/contacts/groups commands use.\n\n" +
        "Run this once and leave it up (e.g. a systemd user unit -- see the README). Logs to " +
        "stderr. Needs SIGNAL_ACCOUNT (and, if signal-cli's data isn't in the default location, " +
        "SIGNAL_CONFIG_DIR); the account must already be linked via `signal-cli link`.",
    )
    .action(async () => {
      const config = resolveDaemonConfig(resolveAccount());
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await runIngestionDaemon(config, { signal: controller.signal });
    });
}

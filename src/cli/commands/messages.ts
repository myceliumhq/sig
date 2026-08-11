import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeTable,
} from "@myceliumhq/toolkit";
import { MAX_MESSAGES_LIMIT } from "../../limits.js";
import { resolveClient } from "../config.js";

const MAX_LIMIT = MAX_MESSAGES_LIMIT;
const DEFAULT_LIMIT = 20;

export function registerMessages(program: Command): void {
  addSubcommand(program, "messages")
    .summary("Read stored messages, optionally filtered by sender or group.")
    .description(
      "Reads sig-server's message store (newest first). Each row's `ts` is the message's send " +
        "timestamp -- pass it to `react` as the target timestamp. Receipts and sync-noise are " +
        "excluded.",
    )
    .option(
      "--sender <id>",
      "Filter to a contact number/uuid (matches conversation key or sender).",
    )
    .option("--group <id>", "Filter to a specific group's messages.")
    .option("--limit <n>", `Max messages, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--json", "Emit JSONL (one message per line) instead of a table.")
    .action(async (options: { sender?: string; group?: string; limit: string; json?: boolean }) => {
      const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });
      const rows = await resolveClient().listMessages({
        sender: options.sender,
        groupId: options.group,
        limit,
      });
      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "TIME", value: (r) => r.time.slice(0, 19).replace("T", " "), maxWidth: 20 },
          { header: "DIR", value: (r) => (r.direction === "outgoing" ? "->" : "<-"), maxWidth: 3 },
          { header: "FROM", value: (r) => r.sender_name || r.sender || r.source, maxWidth: 22 },
          { header: "TS", value: (r) => String(r.ts), maxWidth: 15 },
          { header: "BODY", value: (r) => r.body.replace(/\s+/g, " "), maxWidth: 50 },
        ]);
      }
    });
}

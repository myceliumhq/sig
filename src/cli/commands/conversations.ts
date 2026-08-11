import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeTable,
} from "@myceliumhq/toolkit";
import { MAX_CONVERSATIONS_LIMIT } from "../../limits.js";
import { resolveClient } from "../config.js";

const MAX_LIMIT = MAX_CONVERSATIONS_LIMIT;
const DEFAULT_LIMIT = 20;

export function registerConversations(program: Command): void {
  addSubcommand(program, "conversations")
    .summary("List recent conversations from sig-server's message store.")
    .description(
      "Reads the SQLite store the `sig daemon` process writes (via sig-server) -- newest activity " +
        "first, each with its conversation key (a contact number, or group:<id>), last message " +
        "preview, and message count. Needs the daemon to have been running to have data.",
    )
    .option("--limit <n>", `Max conversations, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--json", "Emit JSONL (one conversation per line) instead of a table.")
    .action(async (options: { limit: string; json?: boolean }) => {
      const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });
      const rows = await resolveClient().listConversations(limit);
      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "CONVERSATION", value: (r) => r.source, maxWidth: 28 },
          { header: "MSGS", value: (r) => String(r.message_count), maxWidth: 6 },
          {
            header: "LAST",
            value: (r) => r.last_time.slice(0, 19).replace("T", " "),
            maxWidth: 20,
          },
          { header: "PREVIEW", value: (r) => r.last_body.replace(/\s+/g, " "), maxWidth: 50 },
        ]);
      }
    });
}

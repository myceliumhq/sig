import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeTable,
} from "@myceliumhq/toolkit";
import { resolveClient } from "../config.js";

export function registerAttachments(program: Command): void {
  addSubcommand(program, "attachments <ts>")
    .summary("List attachments on a specific message.")
    .description(
      "Looks up attachments by the message's send timestamp (the `ts` from `messages`/`search`), " +
        "via sig-server. Returns metadata only (id, filename, content type, size) -- fetch the " +
        "actual bytes with `sig save-attachment <id> --out <path>`. --sender/--group narrow the " +
        "match if the same ts could plausibly collide across conversations (rare in practice: ts is " +
        "signal-cli's real send timestamp).",
    )
    .option("--sender <id>", "Narrow to a 1:1 conversation by contact number/uuid.")
    .option("--group <id>", "Narrow to a specific group.")
    .option("--json", "Emit JSONL (one attachment per line) instead of a table.")
    .addHelpText(
      "after",
      "\nExamples:\n  sig attachments 1699999999999\n" +
        "  sig attachments 1699999999999 --sender +491700000000\n" +
        "  sig save-attachment <id> --out ./photo.jpg",
    )
    .action(async (tsRaw: string, options: { sender?: string; group?: string; json?: boolean }) => {
      const ts = parseBoundedInt(tsRaw, { min: 1, max: Number.MAX_SAFE_INTEGER, flag: "<ts>" });
      const rows = await resolveClient().listAttachments(ts, {
        sender: options.sender,
        groupId: options.group,
      });
      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "ID", value: (r) => r.id, maxWidth: 24 },
          { header: "FILE", value: (r) => r.file_name ?? "?", maxWidth: 24 },
          { header: "TYPE", value: (r) => r.content_type ?? "?", maxWidth: 20 },
          { header: "SIZE", value: (r) => (r.size != null ? String(r.size) : "?"), maxWidth: 10 },
        ]);
      }
    });
}

import { addSubcommand, type Command, writeJsonLines, writeTable } from "@myceliumhq/toolkit";
import { resolveClient } from "../config.js";

export function registerGroups(program: Command): void {
  addSubcommand(program, "groups")
    .summary("List Signal groups this account belongs to.")
    .description(
      "Lists groups via sig-server. Pass a returned group id to `send`/`react` with --group to act " +
        "in that group instead of a 1:1 chat.",
    )
    .option("--json", "Emit JSONL (one group per line) instead of a table.")
    .action(async (options: { json?: boolean }) => {
      const rows = await resolveClient().listGroups();
      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "ID", value: (r) => r.id ?? "", maxWidth: 48 },
          { header: "NAME", value: (r) => r.name ?? "", maxWidth: 32 },
          { header: "MEMBERS", value: (r) => String(r.members), maxWidth: 8 },
        ]);
      }
    });
}

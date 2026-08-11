import { addSubcommand, type Command, writeJsonLines, writeTable } from "@myceliumhq/toolkit";
import { resolveClient } from "../config.js";

export function registerContacts(program: Command): void {
  addSubcommand(program, "contacts")
    .summary("List Signal contacts (resolve a name to a phone number before sending).")
    .description(
      "Lists the contacts known to this account via sig-server. Use it to resolve a person's name " +
        "to the E.164 number `send`/`react` take -- never guess a number.",
    )
    .option("--json", "Emit JSONL (one contact per line) instead of a table.")
    .action(async (options: { json?: boolean }) => {
      const rows = await resolveClient().listContacts();
      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "NUMBER", value: (r) => r.number ?? "", maxWidth: 18 },
          { header: "NAME", value: (r) => r.name ?? "", maxWidth: 32 },
          { header: "UUID", value: (r) => r.uuid ?? "", maxWidth: 36 },
        ]);
      }
    });
}

import { addSubcommand, type Command, writeJson } from "@myceliumhq/toolkit";
import { resolveClient } from "../config.js";

// Answers "what account am I" -- a real gap an agent hit: `sig contacts` lists
// OTHER people's numbers, never this account's own, and there was no other
// way to ask short of re-deriving it from SIGNAL_ACCOUNT on a machine that
// might not even have that env var set (the CLI only needs SIG_SERVER_URL/
// SIG_SERVER_TOKEN). sig-server's GET /v1/health already returns the account
// -- this just surfaces it as its own discoverable command instead of
// something only `doctor` incidentally touches.
export function registerWhoami(program: Command): void {
  addSubcommand(program, "whoami")
    .summary("Print the Signal account number this sig-server is linked to.")
    .description(
      "Calls sig-server's GET /v1/health and prints its `account` (E.164 phone number, this " +
        "account's own -- not a contact's) and whether sig-server is running read-only.",
    )
    .option("--json", 'Emit {"account":...,"read_only":...} instead of plain text.')
    .action(async (options: { json?: boolean }) => {
      const health = await resolveClient().health();
      if (options.json) {
        writeJson({ account: health.account, read_only: health.read_only });
      } else {
        process.stdout.write(`${health.account}${health.read_only ? " (read-only)" : ""}\n`);
      }
    });
}

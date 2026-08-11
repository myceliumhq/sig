import { addSubcommand, CliError, type Command, EXIT_CODES, writeJson } from "@myceliumhq/toolkit";
import type { SendTarget } from "../../signal-client.js";
import { requireE164 } from "../api.js";
import { resolveClient } from "../config.js";

export function registerReact(program: Command): void {
  addSubcommand(program, "react <recipient> <emoji> <target-timestamp>")
    .summary("Add or remove an emoji reaction to a specific message.")
    .description(
      "Reacts to the message identified by its author and send timestamp (the `ts` from " +
        "`messages`), via sig-server. By default <recipient> is the E.164 number of a 1:1 chat, and " +
        "is also the author of the target message. With --group, <recipient> is a group id and " +
        "--author (the group member who sent the target message) is required. Only run when " +
        "explicitly asked.",
    )
    .option("--group", "Treat <recipient> as a group id and react within that group.")
    .option("--author <number>", "Author of the target message (defaults to <recipient> for 1:1).")
    .option("--remove", "Remove a previously-sent reaction instead of adding one.")
    .addHelpText(
      "after",
      "\nExamples:\n  sig react +491700000000 👍 1699999999999\n" +
        "  sig react <group-id> 🎉 1699999999999 --group --author +491700000000",
    )
    .action(
      async (
        recipient: string,
        emoji: string,
        targetTimestampRaw: string,
        options: { group?: boolean; author?: string; remove?: boolean },
      ) => {
        const targetTimestamp = Number(targetTimestampRaw);
        if (!Number.isInteger(targetTimestamp) || targetTimestamp <= 0) {
          throw new CliError("<target-timestamp> must be a positive integer (ms)", {
            exitCode: EXIT_CODES.usage,
            fix: "use the `ts` value from `sig messages`",
          });
        }
        if (!options.group) requireE164(recipient);
        const target: SendTarget = options.group ? { groupId: recipient } : { recipient };
        const targetAuthor = options.author ?? (options.group ? undefined : recipient);
        if (!targetAuthor) {
          throw new CliError("--author is required when reacting in a group", {
            exitCode: EXIT_CODES.usage,
            fix: "pass --author <number> (the group member who sent the target message)",
          });
        }
        if (targetAuthor) requireE164(targetAuthor, "--author");
        await resolveClient().react({
          target,
          emoji,
          targetAuthor,
          targetTimestamp,
          remove: options.remove,
        });
        writeJson({
          reacted: true,
          removed: options.remove ?? false,
          target,
          target_author: targetAuthor,
          target_timestamp: targetTimestamp,
          emoji,
        });
      },
    );
}

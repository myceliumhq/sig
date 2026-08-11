import { existsSync } from "node:fs";
import { addSubcommand, CliError, type Command, EXIT_CODES, writeJson } from "@myceliumhq/toolkit";
import type { SendTarget } from "../../signal-client.js";
import { requireE164 } from "../api.js";
import { resolveClient } from "../config.js";

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerSend(program: Command): void {
  addSubcommand(program, "send <recipient> <message...>")
    .summary("Send a message to a contact (by number) or a group (with --group).")
    .description(
      "Sends a text message from the user's account via sig-server. By default <recipient> is an " +
        "E.164 phone number (1:1). With --group, <recipient> is instead a group id (from `groups`). " +
        "This actually delivers -- only run it when explicitly asked to send.",
    )
    .option("--group", "Treat <recipient> as a group id and send to that group.")
    .option(
      "--attachment <path>",
      "Attach a local file (repeatable for multiple attachments). Read from this machine and " +
        "uploaded to sig-server.",
      collect,
      [],
    )
    .addHelpText(
      "after",
      '\nExamples:\n  sig send +491700000000 "on my way"\n  sig send <group-id> "hi all" --group\n' +
        '  sig send +491700000000 "see attached" --attachment ./photo.jpg',
    )
    .action(
      async (
        recipient: string,
        messageParts: string[],
        options: { group?: boolean; attachment: string[] },
      ) => {
        const message = messageParts.join(" ");
        if (!options.group) requireE164(recipient);
        for (const path of options.attachment) {
          if (!existsSync(path)) {
            throw new CliError(`--attachment file not found: ${path}`, {
              exitCode: EXIT_CODES.usage,
              fix: "pass an existing local file path",
            });
          }
        }
        const target: SendTarget = options.group ? { groupId: recipient } : { recipient };
        const result = await resolveClient().send(target, message, options.attachment);
        writeJson({
          sent: true,
          target,
          timestamp: result.timestamp,
          attachments: options.attachment.length,
        });
      },
    );
}

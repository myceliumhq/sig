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
    .option(
      "--reply-to <ts>",
      "Quote/reply to the message with this send timestamp (the `ts` from `sig messages`). The " +
        "quoted text is auto-filled server-side from sig-server's own store when available.",
    )
    .option(
      "--reply-author <number>",
      "Author of the quoted message (defaults to <recipient> for 1:1; required with --group).",
    )
    .addHelpText(
      "after",
      '\nExamples:\n  sig send +491700000000 "on my way"\n  sig send <group-id> "hi all" --group\n' +
        '  sig send +491700000000 "see attached" --attachment ./photo.jpg\n' +
        '  sig send +491700000000 "sounds good" --reply-to 1699999999999',
    )
    .action(
      async (
        recipient: string,
        messageParts: string[],
        options: {
          group?: boolean;
          attachment: string[];
          replyTo?: string;
          replyAuthor?: string;
        },
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
        let reply: { ts: number; author?: string } | undefined;
        if (options.replyTo !== undefined) {
          const ts = Number(options.replyTo);
          if (!Number.isInteger(ts) || ts <= 0) {
            throw new CliError("--reply-to must be a positive integer (ms)", {
              exitCode: EXIT_CODES.usage,
              fix: "use the `ts` value from `sig messages`",
            });
          }
          const author = options.replyAuthor ?? (options.group ? undefined : recipient);
          if (!author) {
            throw new CliError("--reply-author is required when replying with --group", {
              exitCode: EXIT_CODES.usage,
              fix: "pass --reply-author <number> (the group member who sent the quoted message)",
            });
          }
          if (author) requireE164(author, "--reply-author");
          reply = { ts, author };
        }
        const target: SendTarget = options.group ? { groupId: recipient } : { recipient };
        const result = await resolveClient().send(target, message, options.attachment, reply);
        writeJson({
          sent: true,
          target,
          timestamp: result.timestamp,
          attachments: options.attachment.length,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      },
    );
}

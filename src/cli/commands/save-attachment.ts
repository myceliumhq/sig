import { addSubcommand, type Command, writeJson } from "@myceliumhq/toolkit";
import { resolveClient } from "../config.js";

export function registerSaveAttachment(program: Command): void {
  addSubcommand(program, "save-attachment <id>")
    .summary("Download an attachment's bytes to a local file.")
    .description(
      "Looks up the attachment by id (from `sig attachments <ts>`) and writes its bytes to --out on " +
        "this machine, via sig-server. --out is always a path on whatever machine `sig` itself runs " +
        "on -- it has nothing to do with where the bytes live on the sig-server host.",
    )
    .requiredOption("--out <path>", "Local file path to write the attachment's bytes to.")
    .addHelpText(
      "after",
      "\nExample: sig save-attachment sent:1699999999999:0 --out ./downloaded.jpg",
    )
    .action(async (id: string, options: { out: string }) => {
      await resolveClient().saveAttachment(id, options.out);
      writeJson({ saved: true, id, out: options.out });
    });
}

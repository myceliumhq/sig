#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProgram, runProgram } from "@myceliumhq/toolkit";
import { registerAttachments } from "./commands/attachments.js";
import { registerContacts } from "./commands/contacts.js";
import { registerConversations } from "./commands/conversations.js";
import { registerDaemon } from "./commands/daemon.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerGroups } from "./commands/groups.js";
import { registerMessages } from "./commands/messages.js";
import { registerReact } from "./commands/react.js";
import { registerSaveAttachment } from "./commands/save-attachment.js";
import { registerSearch } from "./commands/search.js";
import { registerSend } from "./commands/send.js";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = createProgram(
  "sig",
  "Signal messenger CLI for agents -- read, search, send, and react to messages via signal-cli.",
  version,
);
registerDaemon(program);
registerSearch(program);
registerConversations(program);
registerMessages(program);
registerAttachments(program);
registerSaveAttachment(program);
registerContacts(program);
registerGroups(program);
registerSend(program);
registerReact(program);
registerDoctor(program);

runProgram(program, process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

import { CliError, EXIT_CODES } from "@myceliumhq/toolkit";
import { isE164 } from "../e164.js";

// Validated locally -- before it ever reaches sig-server -- so a malformed
// recipient is exit 2 (bad usage, the caller can fix the command) rather
// than a round trip that surfaces the same rejection as a network error.
// See ../e164.ts for the format itself and why the MCP tools/sig-server share
// this same check.
export function requireE164(recipient: string, label = "<recipient>"): string {
  if (!isE164(recipient)) {
    throw new CliError(
      `${label} must be an E.164 phone number (e.g. +491700000000): got "${recipient}"`,
      {
        exitCode: EXIT_CODES.usage,
        fix: "pass a number like +491700000000, or use --group with a group id from `sig groups`",
      },
    );
  }
  return recipient;
}

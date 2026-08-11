// Read-only mode for the standalone MCP server (SIGNAL_READ_ONLY=true).
//
// Dependency-free and name-based: the partition below can be unit-tested
// without standing anything up.

/**
 * Tools that only ever read (from the local message store or signal-cli's
 * directory). This is the exact set the standalone server keeps when read-only
 * mode is on. signal_list_contacts/signal_list_groups belong here: they're how
 * a phone number / group id gets resolved for the read tools' filters in the
 * first place, and listing is not a mutation.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "signal_list_contacts",
  "signal_list_groups",
  "signal_list_conversations",
  "signal_list_messages",
  "signal_search_messages",
  "signal_list_attachments",
  "signal_whoami",
]);

/**
 * Tools that send/mutate on the user's Signal account -- everything read-only
 * mode drops. Not used by the filter (which keys off READ_ONLY_TOOL_NAMES
 * alone); it exists so a test can assert every registered tool is classified
 * one way or the other, so a newly added tool can't silently slip into the
 * dropped set.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "signal_send_message",
  "signal_send_reaction",
]);

/**
 * Trim a tool list down to the read-only tools when read-only mode is on. The
 * trim is hard: filtered-out tools are never handed to createMcpServer, so they
 * don't appear in tools/list and there's no handler to reach -- the only
 * version of this that's actually a security property for an HTTP-reachable
 * server.
 */
export function filterReadOnlyTools<T extends { name: string }>(
  tools: readonly T[],
  readOnly: boolean,
  readOnlyNames: ReadonlySet<string> = READ_ONLY_TOOL_NAMES,
): T[] {
  if (!readOnly) return [...tools];
  return tools.filter((tool) => readOnlyNames.has(tool.name));
}

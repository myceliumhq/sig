// Per-command result-count caps, shared by the CLI (src/cli/commands/*.ts)
// and the MCP tools (src/tools/*.ts) so an agent's mental model of "how much
// can I ask for" doesn't silently differ between the two surfaces. Caught
// live: the CLI's `messages --help` advertised 500 while the MCP
// `signal_list_messages` tool capped at 200, and `search --help` advertised
// 100 while the MCP `signal_search_messages` tool capped at 200 -- an agent
// that read one surface's docs and called the other got a silently smaller
// page than expected.
export const MAX_MESSAGES_LIMIT = 200;
export const MAX_CONVERSATIONS_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 200;

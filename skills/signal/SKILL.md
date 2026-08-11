---
name: "signal"
description: "Read, search, send, and react to the user's Signal messages with the `sig` CLI (built on signal-cli). Use for: catching up on conversations, finding a past message, sending a message or reaction on request."
---

# Signal (`sig` CLI)

`sig --help` lists every command; `sig <command> --help` shows its flags. Config comes from the
`SIG_SERVER_URL` and `SIG_SERVER_TOKEN` env vars (a running `sig-server`'s base URL and its bearer
token) -- run `sig doctor` first if a command fails with a config error.

**Architecture you must understand:** `sig` doesn't talk to a live Signal API on each call, and it
doesn't read a local database either. A long-running `sig daemon` process (on some always-on host)
owns the `signal-cli` child process, receives every incoming message in real time, and writes it to
a local SQLite store. `sig-server`, co-located with the daemon, exposes that store and the daemon's
send/react capability over a small bearer-token-gated HTTP API. Every `sig` command you'd run
(`conversations`/`messages`/`search`/`send`/`react`/`contacts`/`groups`/`attachments`/
`save-attachment`) is a thin HTTP client against `sig-server` -- **if `SIG_SERVER_URL`/
`SIG_SERVER_TOKEN` aren't set, or the daemon behind that `sig-server` isn't running, nothing works**
-- `sig doctor` tells you which.

## Commands

| Command | Use it for |
| --- | --- |
| `sig daemon` | Long-lived ingestion supervisor. The user runs this once (systemd unit); you normally don't. Without it, nothing else has data. |
| `sig conversations [--limit N] [--json]` | Recent conversations (newest first): conversation key, last message preview, count. |
| `sig messages [--sender X] [--group ID] [--limit N] [--json]` | Read stored messages, optionally filtered. Each row's `ts` is the message send timestamp -- pass it to `react`. |
| `sig search <query> [--limit N] [--json]` | Full-text search over message bodies. Hybrid lexical+semantic automatically when SIGNAL_SEMANTICD_URL is set. |
| `sig contacts [--json]` | List contacts. Resolve a name to an E.164 number before sending -- never guess. |
| `sig groups [--json]` | List groups. Use a group id with `send`/`react` `--group`. |
| `sig send <recipient> <message> [--group] [--attachment PATH...]` | Send a message, optionally with local file attachments. `<recipient>` is a phone number, or a group id with `--group`. |
| `sig react <recipient> <emoji> <target-ts> [--group] [--author N] [--remove]` | React to a message by its author + `ts`. In a group, `<recipient>` is the group id and `--author` (target message sender) is required. |
| `sig attachments <ts> [--sender X] [--group ID] [--json]` | List attachment metadata (id, filename, type, size) on a message. |
| `sig save-attachment <id> --out <path>` | Download an attachment's bytes to a local file (on whatever machine `sig` itself runs on). |
| `sig doctor` | Verify `SIG_SERVER_URL`/`SIG_SERVER_TOKEN` and that `sig-server` answers with a valid token. |

## Facts

- List commands default to a table; add `--json` for JSONL (one object per line).
- `ts` is the message's send timestamp in ms -- it's both the natural key and what `react` needs
  as `<target-timestamp>`. Get it from `messages`/`search`, never invent it.
- Conversation key (`source`): a contact's E.164 number for 1:1 chats, `group:<id>` for groups.
  Both directions of a chat share one key, so filtering by `--sender <number>` catches sent and
  received messages alike.
- Only real messages appear in `conversations`/`messages`/`search`. Delivery/read receipts and
  sync-noise are stored but hidden, and never indexed.
- Semantic search has no reliable "zero results" signal on its own -- it's nearest-neighbor cosine
  similarity, which always returns *something*. With `--json`, each row has `match_source`
  (`lexical`/`semantic`/`both`); if every result is `semantic` (no lexical hits), that's the real
  "probably found nothing" signal, and `search` also prints a stderr warning then.
- Exit codes are deterministic: `0` ok, `2` bad usage, `3` not found, `4` config/auth or the
  daemon socket being unreachable (run `sig doctor`). Branch on these, don't parse stderr text.

## Procedure

1. Catching up -> `sig conversations` for an overview, then `sig messages --sender <number>` (or
   `--group <id>`) to read a specific thread.
2. Finding something specific -> `sig search "<query>"`. If results are all `match_source:
   "semantic"` (or you see the stderr warning), treat it as "nothing found" and broaden.
3. Sending, only when explicitly asked:
   - Resolve the person -> `sig contacts --json` -> their E.164 number (or `sig groups` -> group id).
   - `sig send <number> "<message>"` (or `sig send <group-id> "<message>" --group`).
4. Reacting, only when explicitly asked: find the target message via `sig messages`, take its `ts`,
   then `sig react <number> <emoji> <ts>` (1:1) or `sig react <group-id> <emoji> <ts> --group
   --author <sender-number>` (group).

## Safety rules

- Never send a message or reaction (`send`, `react`) unless the user explicitly asked for that
  exact action. This skill is read/triage-first.
- Never guess a phone number, group id, or timestamp -- resolve every one from `contacts`/`groups`/
  `messages` first. A wrong number sends to the wrong person.
- When multiple contacts/messages plausibly match, present options; don't pick for the user.
- Never fabricate a message's existence or contents.

## No shell available?

The same functionality is exposed as a standalone MCP server (tools `signal_list_conversations`,
`signal_list_messages`, `signal_list_attachments`, `signal_search_messages`, `signal_list_contacts`,
`signal_list_groups`, `signal_send_message`, `signal_send_reaction`) -- see the package README for
setup. The ingestion daemon still has to be running separately for the read tools to have data.
This is a deliberate, separate integration from the `sig` CLI's own remote mode
(`SIG_SERVER_URL`/`SIG_SERVER_TOKEN` against `sig-server`) -- pick one, not both, for a given
integration.

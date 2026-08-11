# AGENTS.md

## Using this CLI

No install needed for one-off use: `npx @myceliumhq/sig <command>`. Every command except `sig
daemon` talks to a running `sig-server` over HTTP -- needs `SIG_SERVER_URL` and `SIG_SERVER_TOKEN`
set (see "Remote mode" in the README). `sig daemon` is the one exception: it's inherently local
(it owns the `signal-cli` child process) and needs `SIGNAL_ACCOUNT` set directly, with the account
already linked via `signal-cli link`. Read `skills/signal/SKILL.md` first for the command reference
and decision guidance instead of discovering it via `--help` alone -- it also covers safety rules
(never send/react without being asked, never guess a number or timestamp).

@README.md has what this package does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## What's different about this app

Unlike the sibling apps (`ppl` for paperless-ngx, `tri` for Trilium), which call an already-running
external REST service, `sig` **owns and supervises a `signal-cli` child process itself** — that's
the core subsystem here. The design is deliberate:

- `signal-cli ... daemon --socket <path> --receive-mode on-start` (with `-o json`) does two things
  at once: exposes a JSON-RPC command interface over a Unix socket, and prints every received
  envelope to its **stdout** in real time as a `{"method":"receive","params":{"envelope":...}}`
  notification.
- `sig daemon` (`src/ingest/daemon.ts`) spawns that process, tails its stdout into SQLite, and
  auto-restarts it with backoff. Because sig owns the process, it is **always the sole receiver**.
  This sidesteps a real bug that killed an earlier prototype: signal-cli allows only one active
  receiver per account, and an *external* long-poller that timed out left the server-side receiver
  wedged, silently dropping inbound messages for minutes. There is no external poller here and no
  long-poll/abort mechanism at all — messages arrive on stdout as they happen, and anything missed
  while the daemon is down is held server-side and delivered on the next start (verified live).
- Everything else — the standalone MCP server, `sig-server`, the semanticd adapter — just **reads
  the SQLite store** the daemon wrote, and (for sends) issues JSON-RPC to the **same** daemon
  socket via `src/signal-client.ts`. Nothing else ever becomes a second receiver.
- The `sig` CLI itself no longer touches the store/socket directly except for `sig daemon`: every
  other command is a thin HTTP client (`src/cli/client.ts`) against `sig-server`
  (`src/server.ts`), which is meant to run co-located with the daemon (same host, same
  socket/store — like the MCP server already does) so the CLI can be driven from a *different*
  machine. `SIG_SERVER_URL` + `SIG_SERVER_TOKEN` are required for every non-daemon command; there
  is no local-socket/SQLite fallback.

The ingestion daemon is meant to run continuously (a systemd user unit; see README). The socket
path must stay **short** (AF_UNIX ~104-char limit) and is kept separate from the state-dir DB path
for exactly that reason — see `src/paths.ts`.

## Layout

- `src/cli/` — the `sig` CLI (primary interface): `index.ts` wires Commander subcommands from
  `commands/*.ts` onto `@myceliumhq/toolkit`'s `createProgram`/`runProgram`; `api.ts` holds
  `requireE164` (client-side format validation, exit 2, before ever calling sig-server);
  `config.ts` resolves `SIG_SERVER_URL`/`SIG_SERVER_TOKEN` (`resolveClient()`, required for every
  command but `daemon`) plus `SIGNAL_ACCOUNT` (`resolveAccount()`, `daemon`-only) lazily, so
  `--help` never needs env vars set; `client.ts` is the `fetch`-based HTTP client against
  `sig-server`'s `/v1/*` endpoints, mapping non-2xx responses onto the exit-code contract
  (`mapStatus` — 401/403/502-504→4, 400→2, 404→3, 422→1) so the CLI behaves identically regardless
  of which `sig-server` instance it's pointed at.
- `src/server.ts` + `src/server-config.ts` — `sig-server`: a bearer-token-gated JSON HTTP API
  (plain REST-ish request/response, not MCP framing) meant to run co-located with `sig daemon`
  (same host, same socket/store — like the MCP server already does). It's what makes the `sig`
  CLI usable from a different machine. Read routes and the reaction/send routes reuse the exact
  same tool factories from `src/tools/*.ts` that back the MCP server, so validation and business
  logic live in exactly one place; attachment listing/streaming and the multipart `/v1/send` are
  bespoke (tools can't take binary uploads). Every request requires
  `Authorization: Bearer <SIG_SERVER_TOKEN>` — no loopback bypass, unlike the MCP server's
  loopback-vs-non-loopback distinction, since sig-server's whole purpose is being reached
  remotely.
- `src/ingest/` — the ingestion subsystem: `daemon.ts` (spawn/supervise signal-cli, auto-restart;
  also writes the `HEARTBEAT` activity-marker file and logs the active `SIGNAL_MAX_STORED` cap on
  startup), `parse.ts` (envelope parsing + `kind` classification:
  `message`/`reaction`/`receipt`/`sync-noise`, plus `toRemoteDelete()` for "delete for everyone"
  events, handled as an UPDATE tombstone rather than an insert), `store.ts` (the SQLite layer on
  `node:sqlite`'s `DatabaseSync`, `UNIQUE(source, ts)` dedup; prunes oldest rows past
  `SIGNAL_MAX_STORED` every 100 inserts, along with orphaned attachment rows; every read query
  excludes `deleted_at IS NOT NULL` rows by default). New columns land via an additive
  `ALTER TABLE` migration guarded by a `PRAGMA table_info` check in the constructor -- there is a
  real deployed production DB, so schema changes must never be destructive.
- `src/send-rate-limit.ts` — a per-process, in-memory 5-second warn-not-block guard shared by
  `createSendMessageTool`/`createSendReactionTool` (`src/tools/messaging.ts`): a send or reaction
  within 5s of the previous one gets a `warning` field in the tool/HTTP result rather than being
  blocked. Not persisted or cross-process by design (see the module's own comment).
- `src/signal-client.ts` — thin JSON-RPC-over-Unix-socket client (newline-delimited JSON) for
  `send`/`sendReaction`/`listContacts`/`listGroups`, used by the MCP tools and `sig-server` (which
  the `sig` CLI now reaches indirectly, through those same tools).
- `src/paths.ts` — state-dir DB path vs. short socket path resolution.
- `src/agent-tool.ts` — the `AnyAgentTool` shape tool factories type their return value against.
- `src/tools/` — one file per tool group (directory, messaging, messages) plus `read-only.ts`.
  Every tool here is shared by the MCP server *and* `sig-server`.
- `src/search-core.ts` — shared lexical+semantic hybrid search (RRF), used by the
  `signal_search_messages` MCP/`sig-server` tool (and so, transitively, `sig search`).
- `src/semantic/` — `handle.ts` is a thin client of a deployed `sig-semanticd` sidecar (via
  `@myceliumhq/semanticd`'s `createSemanticdClient`), not a local index. `source-adapter.ts` is the
  Signal-specific piece the sidecar syncs — and unusually it reads straight from the **local**
  SQLite store (sig already holds authoritative state), not from a remote API. Consumed via
  `semantic-adapter.ts`/`semanticd-bin.ts`.
- `src/mcp-server.ts` — standalone MCP server entrypoint on `@myceliumhq/mcp` (stdio/HTTP),
  configured via env vars; `createAllTools` is the complete tool list, importable by tests without
  booting a server. `src/mcp-server-config.ts` holds the (testable) env-var parsing, including
  `SIGNAL_READ_ONLY` (a hard trim of the write tools) — its helpers (`readEnvOrFile`,
  `parsePortEnv`, `parseBindHost`, `readReadOnlyFlag`, `readSemanticSearchConfig`) are exported and
  reused by `src/server-config.ts`/`src/server.ts` and `src/cli/config.ts` rather than
  reimplemented.
- `src/semanticd-bin.ts` — the `sig-semanticd` binary: passes `semantic-adapter.ts`'s
  `createAdapter()` straight into `runSemanticd()`. `Dockerfile.semanticd` builds its image.
  `Dockerfile.server` builds `sig-server`'s image the same way.
- `skills/` — agent skills bundled with the package.

## Philosophy (shared across every mycelium CLI)

Token-cheap `--help`; deterministic exit codes (0 ok, 2 bad usage, 3 not found, 4 config/auth or
daemon unreachable); `--json` JSONL for list commands; no interactive prompts; the MCP server as
the no-shell fallback.

## Working in this repo

- Run `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` before committing.
  `build`'s `tsc` excludes test files from the compile; `typecheck` type-checks them.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- `node:sqlite` requires Node ≥ 22.5 (`engines.node` reflects this); no native module to compile.

# sig

[![CI](https://github.com/myceliumhq/sig/actions/workflows/ci.yml/badge.svg)](https://github.com/myceliumhq/sig/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An agent-facing CLI for [Signal](https://signal.org/) messenger, built on top of
[`signal-cli`](https://github.com/AsamK/signal-cli). Read, search, send, and react to messages —
the same things you'd do by hand in a Signal client.

Built for coding agents: token-cheap `--help`, deterministic exit codes, `--json` JSONL output, no
interactive prompts.

A standalone [MCP](https://modelcontextprotocol.io) server is also included, for hosts without a
shell.

## How it works

Unlike a REST-backed CLI, `sig` supervises a `signal-cli` process itself. A long-running **ingestion
daemon** (`sig daemon`) owns that process, receives every incoming message in real time, and writes
it to a local SQLite store. Because sig owns the process it's always the sole receiver — no dropped
messages.

The daemon has to run continuously on one host (a server, a homelab box — somewhere that's always
on), which is rarely the same machine you're running the `sig` CLI from. So a second piece,
**`sig-server`**, runs alongside the daemon on that same host and exposes a small bearer-token-gated
HTTP API. The `sig` CLI (everywhere except `sig daemon` itself) is a thin HTTP client against it —
see "Remote mode" below.

So there are three things, but only two you actually run continuously: the **daemon** (on the
always-on host, kept up) and **`sig-server`** (same host, kept up alongside it). The **CLI** you run
wherever you're working, pointed at `sig-server` over the network.

## Prerequisites

1. Install signal-cli (tested with v0.14.7): `brew install signal-cli` (macOS) or see signal-cli's
   README.
2. Link an account (like linking Signal Desktop — scan the QR with your phone):
   ```bash
   signal-cli link -n "sig"
   ```
3. Note the linked phone number; that's your `SIGNAL_ACCOUNT`.

## Use

Install globally so `sig`/`sig-server` are plain commands on PATH -- the resolve/download-check
`npx` does on every single call adds up fast across an agent's many small invocations:

```bash
npm install --global @myceliumhq/sig
```

Run the daemon and `sig-server` on the same host (they're always co-located — `sig-server` reads
the daemon's store and talks to its socket, same as the MCP server does):

```bash
export SIGNAL_ACCOUNT=+491700000000
# optional, if signal-cli's data isn't in its default location:
# export SIGNAL_CONFIG_DIR=/home/you/.local/share/signal-cli

# 1) Start the ingestion daemon (long-lived — leave it running):
sig daemon

# 2) In another shell, on the SAME host: start sig-server (also long-lived):
export SIG_SERVER_TOKEN=$(openssl rand -hex 32)   # pick your own, keep it secret
sig-server
```

Then, from wherever you actually work — the same machine, or (the normal case) your laptop over
the network — point the `sig` CLI at it:

```bash
export SIG_SERVER_URL=http://127.0.0.1:8420   # or wherever sig-server is reachable
export SIG_SERVER_TOKEN=<the token you set above>

sig doctor
sig whoami
sig conversations
sig messages --sender +491700000000 --limit 20
sig search "dinner plans"
sig contacts
sig send +491700000000 "on my way"
sig send +491700000000 "sounds good" --reply-to 1699999999999
sig react +491700000000 👍 1699999999999
sig attachments 1699999999999
sig save-attachment sent:1699999999999:0 --out ./downloaded.jpg
```

No install available? Fall back to `npx @myceliumhq/sig <command>` for the CLI and
`npx @myceliumhq/sig daemon` for the daemon (fetches and caches on first run, same commands
otherwise). `sig-server` needs `npx -p @myceliumhq/sig sig-server` instead -- a bare
`npx @myceliumhq/sig-server` won't work, that's not a real package name, `sig-server` is a *bin*
inside `@myceliumhq/sig`, not its own package (npx only auto-resolves a bin matching the package's
own unscoped name, "sig", without `-p`). Prefer the global install whenever you can, per above.

Every `sig` command except `sig daemon` requires `SIG_SERVER_URL`/`SIG_SERVER_TOKEN` — there's no
mode where the CLI reads the SQLite store or the daemon's socket directly. See "Remote mode" below
for the full picture (why, and how it maps to the exit-code contract).

See `sig <command> --help` for flags, or the bundled skill (`skills/signal/SKILL.md`) for the full
command reference and decision guidance.

### Running the daemon as a service

The daemon needs to stay up. A systemd **user** unit is the simplest way on Linux
(`~/.config/systemd/user/sig.service`):

```ini
[Unit]
Description=sig Signal ingestion daemon
After=network-online.target

[Service]
Environment=SIGNAL_ACCOUNT=+491700000000
# Environment=SIGNAL_CONFIG_DIR=/home/you/.local/share/signal-cli
ExecStart=/usr/bin/sig daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now sig.service
journalctl --user -u sig.service -f   # logs (the daemon logs to stderr)
```

On macOS, a `launchd` LaunchAgent with `KeepAlive` is the equivalent.

The daemon also touches a plain-text `HEARTBEAT` file (`<state dir>/HEARTBEAT`, RFC3339 timestamp,
`SIGNAL_HEARTBEAT_PATH` to override) at most once a minute — on real received activity, or on a
timer if it's been quiet. An external watchdog (a homelab uptime monitor, a cron job) can alert on
staleness. It's an **activity marker, not a liveness proof**: a healthy-but-quiet session still
updates it via the timer, but it can't distinguish "genuinely wedged" from "the whole process is
stuck" with certainty — treat a stale file as worth investigating, not as definitive proof of a
hang.

## Configuration

### `sig daemon` (runs on the always-on host)

| Env var | Required | Notes |
| --- | --- | --- |
| `SIGNAL_ACCOUNT` | yes | Your linked phone number, E.164 (e.g. `+491700000000`) |
| `SIGNAL_CONFIG_DIR` | no | signal-cli data dir. Unset uses signal-cli's default (`~/.local/share/signal-cli`) |
| `SIGNAL_CLI_PATH` | no | Path to the `signal-cli` binary. Default: `signal-cli` on `PATH` |
| `SIGNAL_SOCKET` | no | Unix socket the daemon exposes. Default: `$XDG_RUNTIME_DIR/sig/signal-cli.sock` (or a short `/tmp` path). **Keep it short** (AF_UNIX ~104-char limit) |
| `SIGNAL_DB` | no | SQLite store path. Default: `$XDG_STATE_HOME/sig/messages.db` (or `~/.local/state/sig/messages.db`) |
| `SIGNAL_MAX_STORED` | no | Storage growth cap: oldest rows beyond this count are pruned (batched every 100 inserts), along with any now-orphaned attachment rows. Default `100000` |
| `SIGNAL_HEARTBEAT_PATH` | no | Where the daemon writes its `HEARTBEAT` activity-marker file (see below). Default: `<state dir>/HEARTBEAT` |

### `sig` CLI (runs wherever you work)

| Env var | Required | Notes |
| --- | --- | --- |
| `SIG_SERVER_URL` | yes (every command but `sig daemon`) | Base URL of a running `sig-server`, e.g. `https://sig.example.internal` |
| `SIG_SERVER_TOKEN` | yes (same) | Bearer token `sig-server` is configured with (or `SIG_SERVER_TOKEN_FILE`, a Docker-secret path whose trimmed contents are used) |

`sig-server` and the standalone MCP server resolve `SIGNAL_SOCKET`/`SIGNAL_DB` the same way the
daemon does, so they agree by default when co-located with it — override them together if you move
either. See "Remote mode" below for `sig-server`'s own env vars.

## Semantic search

`sig search` is lexical by default. Optional semantic search is a separate sidecar, `sig-semanticd`
— this package's own binary, built on
[`@myceliumhq/semanticd`](https://github.com/myceliumhq/semanticd) with this repo's adapter wired
in. Unlike ppl/tri it indexes straight from sig's **local** message store (no remote API to reach),
so point it at the same `SIGNAL_DB`:

```bash
export SIGNAL_DB=/home/you/.local/state/sig/messages.db
export EMBEDDING_PROVIDER=local   # zero-API-key CPU model; or openai-compatible, see semanticd's README
sig-semanticd   # or: npx -p @myceliumhq/sig sig-semanticd
```

Or as a container: `ghcr.io/myceliumhq/sig-semanticd:<version>` (built from `Dockerfile.semanticd`,
published on every tagged release). Once it's running, point the CLI and MCP server at it with
`SIGNAL_SEMANTICD_URL` — `sig search` fuses its own lexical results with the sidecar's automatically
(Reciprocal Rank Fusion), no separate mode to pick. Unset (or unreachable), it transparently falls
back to lexical-only.

**On "no results":** semantic search has no reliable "nothing matches" signal by itself —
cosine-similarity nearest-neighbor search always returns *something*. So the semantic score is not a
calibrated confidence measure. With fusion active, `--json` rows include `match_source` (`lexical` |
`semantic` | `both`); if a query returns results with **zero** lexical hits (everything is
`semantic`), `sig search` prints a stderr warning — that's the actual "found nothing real" signal,
not an empty list.

## Remote mode

The `sig` CLI is a thin HTTP client against `sig-server` (`src/server.ts`) — a plain
bearer-token-gated JSON API, **not** MCP framing. `sig-server` runs co-located with `sig daemon`
(same host, same signal-cli socket and SQLite store, exactly like the existing MCP server), and
that's what actually lets the CLI itself be driven from a different machine — a laptop over
Tailscale/a reverse proxy, a CI runner, wherever — without that machine needing local access to the
daemon's Unix socket or SQLite file. `sig daemon` is the one command that stays purely local: it
owns the `signal-cli` child process directly, so running it "remotely" wouldn't mean anything.

```bash
# On the same host as `sig daemon`:
export SIGNAL_ACCOUNT=+491700000000
export SIG_SERVER_TOKEN=$(openssl rand -hex 32)
sig-server   # or: npx -p @myceliumhq/sig sig-server

# From wherever you actually run `sig` (can be the same host, or anywhere reachable):
export SIG_SERVER_URL=http://127.0.0.1:8420
export SIG_SERVER_TOKEN=<same token>
sig conversations
```

| Env var | Required | Notes |
| --- | --- | --- |
| `SIGNAL_ACCOUNT` | yes | Same as the daemon's — used to address the account over the daemon's socket |
| `SIG_SERVER_TOKEN` | yes | Bearer token every request must present (or `SIG_SERVER_TOKEN_FILE`, Docker-secret convention). Refuses to start without one -- there is no other auth layer |
| `SIG_SERVER_PORT` | no | Default `8420` |
| `SIG_SERVER_HOST` | no | Default `127.0.0.1` (loopback). Set `0.0.0.0` only behind a reverse proxy that itself handles TLS/network exposure -- every request is still bearer-token gated regardless |
| `SIG_READ_ONLY` | no | Set to exactly `true` to 403 the write endpoints (`POST /v1/react`, `POST /v1/send`) — same semantics as the MCP server's `SIGNAL_READ_ONLY` |
| `SIGNAL_DB` / `SIGNAL_SOCKET` | no | Same defaults as the daemon; point them at its store/socket |
| `SIGNAL_SEMANTICD_URL` | no | Base URL of a deployed `sig-semanticd` sidecar, for `GET /v1/search` |

Endpoints (all require `Authorization: Bearer <SIG_SERVER_TOKEN>`, all JSON except the attachment
content route): `GET /v1/health`, `GET /v1/contacts`, `GET /v1/groups`,
`GET /v1/conversations?limit=`, `GET /v1/messages?sender=&group_id=&limit=`,
`GET /v1/search?query=&limit=`, `GET /v1/attachments?ts=&sender=&group_id=` (metadata only, no
filesystem paths), `GET /v1/attachments/:id/content` (streams the raw bytes),
`POST /v1/react` (JSON body), `POST /v1/send` (`multipart/form-data`: `recipient`/`group_id`,
`message`, zero or more `attachment` file parts, optional `reply_to_ts`/`reply_to_author` to quote
an earlier message -- the quoted text is auto-filled server-side from the local store when
available). A `send`/`react` repeated within 5 seconds of the previous one (per-process) gets a
non-fatal `warning` field in the response -- not blocked, just visible, so repeated rapid sends'
risk of the account being rate-limited/flagged by Signal is surfaced rather than silent.

This mirrors the homelab convention already used for `tri`/`ppl`: an `<APP>_URL` + `<APP>_TOKEN`
pair, `Authorization: Bearer` to a reverse-proxied hostname — `sig` just names its own pair
`SIG_SERVER_URL`/`SIG_SERVER_TOKEN`.

The CLI's exit codes are identical no matter what `SIG_SERVER_URL` points at — `sig-server`'s HTTP
statuses (401/403/502-504 → config, 400 → usage, 404 → not found, 422 → signal-cli itself rejected
the request) map onto the same `EXIT_CODES` contract documented in `skills/signal/SKILL.md`, so an
agent driving `sig` never needs to know it's talking to a remote server.

A `Dockerfile.server` builds `sig-server`'s image, modeled on the existing MCP server `Dockerfile`
(bind-mount the daemon's store/socket the same way).

## Standalone MCP server

The read/send functionality also runs outside a shell entirely, as an ordinary MCP server (stdio or
Streamable HTTP), via [`@myceliumhq/mcp`](https://github.com/myceliumhq/toolkit/tree/main/packages/mcp).
It is read-side + command-side only: it reads the SQLite store the daemon writes and issues sends to
the daemon's socket — **the daemon still has to be running separately** for it to have any data.

| Env var | Required | Notes |
| --- | --- | --- |
| `SIGNAL_ACCOUNT` | yes | Linked phone number (or `SIGNAL_ACCOUNT_FILE`, a Docker-secret path whose trimmed contents are used) |
| `SIGNAL_DB` / `SIGNAL_SOCKET` | no | Same defaults as the CLI; point them at the daemon's store/socket |
| `SIGNAL_READ_ONLY` | no | Set to exactly `true` to register only read tools — write tools aren't registered at all, so they can't be listed or called |
| `SIGNAL_SEMANTICD_URL` | no | Base URL of a deployed `sig-semanticd` sidecar |
| `SIGNAL_SEMANTIC_SEARCH_ENABLED` | no | Set to exactly `false` to skip semantic search even if the URL is set |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `MCP_PORT` | no | HTTP only; default `3000` |
| `MCP_HOST` | no | HTTP only; default `127.0.0.1` (loopback). Set `0.0.0.0` only behind an authenticated reverse proxy, and only with `MCP_ALLOWED_HOSTS` set (or startup fails) |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated hostnames accepted in `Host` (DNS-rebinding protection). Required when `MCP_HOST=0.0.0.0` |

```bash
pnpm run build
SIGNAL_ACCOUNT=+491700000000 pnpm run start:mcp
```

A `Dockerfile` builds the MCP server image (`Dockerfile.semanticd` for the semantic sidecar).

## Docker images

Four images publish to `ghcr.io/myceliumhq/` on every release:

| Image | Dockerfile | Entrypoint | Role |
|---|---|---|---|
| `sig-daemon` | `Dockerfile.daemon` | `sig daemon` | Owns signal-cli as a child process (bundles signal-cli + a matching JRE). The only stateful, always-on piece -- everything else reads what it writes. **Must be deployed on the `linux/amd64` platform** signal-cli's bundled native `libsignal-client` lib targets. |
| `sig-server` | `Dockerfile.server` | `sig-server` | Bearer-token-gated remote API the CLI talks to (see "Remote mode" above). Co-located with `sig-daemon` (same socket + store). |
| `sig-semanticd` | `Dockerfile.semanticd` | `sig-semanticd` | Semantic search sidecar; reads the same SQLite store. |
| `sig-mcp` | `Dockerfile` | `sig-mcp-server` | Standalone MCP server, for hosts that want MCP instead of `sig-server`. |

`sig-daemon`, `sig-server`, and `sig-semanticd` are meant to run together, sharing two volumes: signal-cli's own config/data dir (the linked-device keys -- **back this up like a secret**) and sig's state dir (`messages.db` + attachments). `sig-daemon` and `sig-server` additionally share a small volume for the Unix socket between them (its path must stay short -- AF_UNIX's ~104-byte limit, see `src/paths.ts`).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup and commit conventions.

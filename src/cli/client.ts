import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError, EXIT_CODES, type ExitCode } from "@myceliumhq/toolkit";
import type { SearchRow } from "../search-core.js";
import type { SendTarget } from "../signal-client.js";

// Thin fetch-based HTTP client for sig-server (src/server.ts). The `sig` CLI
// always talks to a sig-server over the network -- there is no local-socket/
// SQLite fallback here; `sig daemon` is the sole command that still touches
// signal-cli/the store directly (it owns the child process, see
// src/cli/commands/daemon.ts). Every other command goes through this client.

export type ContactRow = {
  number: string | null;
  name: string | null;
  uuid: string | null;
  blocked: boolean;
};
export type GroupRow = {
  id: string | null;
  name: string | null;
  members: number;
  blocked: boolean;
};
export type ConversationRow = {
  source: string;
  group_id: string | null;
  last_ts: number;
  last_time: string;
  last_direction: string | null;
  last_body: string;
  message_count: number;
};
export type MessageListRow = {
  source: string;
  ts: number;
  time: string;
  direction: string | null;
  sender: string | null;
  sender_name: string | null;
  group_id: string | null;
  body: string;
  attachments: number;
};
export type AttachmentRow = {
  id: string;
  source: string;
  ts: number;
  file_name: string | null;
  content_type: string | null;
  size: number | null;
};
export type SearchOutcome = {
  rows: SearchRow[];
  usedSemantic: boolean;
  lexicalCount: number;
  truncated: boolean;
};
export type HealthInfo = { ok: boolean; account: string; read_only: boolean };

export type SigServerClientConfig = {
  baseUrl: string;
  token: string;
};

export type SigServerClient = {
  listContacts(): Promise<ContactRow[]>;
  listGroups(): Promise<GroupRow[]>;
  listConversations(limit: number): Promise<ConversationRow[]>;
  listMessages(filter: {
    sender?: string;
    groupId?: string;
    limit: number;
  }): Promise<MessageListRow[]>;
  search(query: string, limit: number): Promise<SearchOutcome>;
  send(
    target: SendTarget,
    message: string,
    attachmentPaths: string[],
    reply?: { ts: number; author?: string },
  ): Promise<{ timestamp: number | null; warning?: string }>;
  react(params: {
    target: SendTarget;
    emoji: string;
    targetAuthor: string;
    targetTimestamp: number;
    remove?: boolean;
  }): Promise<void>;
  listAttachments(
    ts: number,
    filter: { sender?: string; groupId?: string },
  ): Promise<AttachmentRow[]>;
  saveAttachment(id: string, outPath: string): Promise<void>;
  health(): Promise<HealthInfo>;
};

// Maps a sig-server HTTP status to this app's shared EXIT_CODES contract
// (src/cli/api.ts's runRpc did the equivalent job for the direct-socket
// path this client replaces). Kept case-identical to what a local daemon-RPC
// failure would have produced, per src/server.ts's handleToolError comment:
//   401/403 (auth/read-only)      -> config       (4)
//   400 (bad request/validation)  -> usage         (2)
//   404 (not found)               -> notFound      (3)
//   422 (signal-cli itself rejected the request) -> error (1)
//   502/503/504 (daemon unreachable on the server side) -> config (4)
function mapStatus(status: number): { exitCode: ExitCode; fix?: string } {
  if (status === 401) {
    return { exitCode: EXIT_CODES.config, fix: "check SIG_SERVER_TOKEN" };
  }
  if (status === 403) {
    return { exitCode: EXIT_CODES.config, fix: "sig-server is running with SIG_READ_ONLY=true" };
  }
  if (status === 404) {
    return { exitCode: EXIT_CODES.notFound, fix: "check the id/args and try again" };
  }
  if (status === 400) {
    return { exitCode: EXIT_CODES.usage };
  }
  if (status === 422) {
    return { exitCode: EXIT_CODES.error };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      exitCode: EXIT_CODES.config,
      fix: "ensure `sig daemon` is running on the sig-server host and its socket is reachable",
    };
  }
  return { exitCode: EXIT_CODES.error };
}

export function createSigServerClient(config: SigServerClientConfig): SigServerClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const token = config.token;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot reach sig-server at ${base}: ${message}`, {
        exitCode: EXIT_CODES.config,
        fix: "check SIG_SERVER_URL and that sig-server is running and reachable",
      });
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // Not JSON -- use the raw response text verbatim.
      }
      throw new CliError(message || `${resp.status} ${resp.statusText}`, mapStatus(resp.status));
    }
    return resp;
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await request(path)).json() as Promise<T>;
  }

  return {
    async listContacts() {
      const d = await getJson<{ contacts: ContactRow[] }>("/v1/contacts");
      return d.contacts;
    },
    async listGroups() {
      const d = await getJson<{ groups: GroupRow[] }>("/v1/groups");
      return d.groups;
    },
    async listConversations(limit) {
      const d = await getJson<{ conversations: ConversationRow[] }>(
        `/v1/conversations?limit=${limit}`,
      );
      return d.conversations;
    },
    async listMessages(filter) {
      const params = new URLSearchParams();
      if (filter.sender) params.set("sender", filter.sender);
      if (filter.groupId) params.set("group_id", filter.groupId);
      params.set("limit", String(filter.limit));
      const d = await getJson<{ messages: MessageListRow[] }>(`/v1/messages?${params}`);
      return d.messages;
    },
    async search(query, limit) {
      const params = new URLSearchParams({ query, limit: String(limit) });
      const d = await getJson<{
        results: SearchRow[];
        used_semantic: boolean;
        lexical_hits: number;
        truncated: boolean;
      }>(`/v1/search?${params}`);
      return {
        rows: d.results,
        usedSemantic: d.used_semantic,
        lexicalCount: d.lexical_hits,
        truncated: d.truncated,
      };
    },
    async send(target, message, attachmentPaths, reply) {
      const form = new FormData();
      if ("groupId" in target) form.set("group_id", target.groupId);
      else form.set("recipient", target.recipient);
      form.set("message", message);
      if (reply) {
        form.set("reply_to_ts", String(reply.ts));
        if (reply.author) form.set("reply_to_author", reply.author);
      }
      for (const path of attachmentPaths) {
        const bytes = await readFile(path);
        form.append("attachment", new Blob([bytes]), basename(path));
      }
      const resp = await request("/v1/send", { method: "POST", body: form });
      const d = (await resp.json()) as { timestamp?: number | null; warning?: string };
      return { timestamp: d.timestamp ?? null, warning: d.warning };
    },
    async react(params) {
      const body = {
        emoji: params.emoji,
        target_author: params.targetAuthor,
        target_timestamp: params.targetTimestamp,
        remove: params.remove ?? false,
        ...("groupId" in params.target
          ? { group_id: params.target.groupId }
          : { recipient: params.target.recipient }),
      };
      await request("/v1/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async listAttachments(ts, filter) {
      const params = new URLSearchParams({ ts: String(ts) });
      if (filter.sender) params.set("sender", filter.sender);
      if (filter.groupId) params.set("group_id", filter.groupId);
      const d = await getJson<{ attachments: AttachmentRow[] }>(`/v1/attachments?${params}`);
      return d.attachments;
    },
    async saveAttachment(id, outPath) {
      const resp = await request(`/v1/attachments/${encodeURIComponent(id)}/content`);
      if (!resp.body) {
        throw new CliError("sig-server returned an empty attachment body", {
          exitCode: EXIT_CODES.error,
        });
      }
      await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(outPath));
    },
    async health() {
      return getJson<HealthInfo>("/v1/health");
    },
  };
}

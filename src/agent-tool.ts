import type { TSchema } from "typebox";

// Local, harness-agnostic tool shape -- tool factories in src/tools/*.ts
// type their return value against this. Structurally compatible with
// @myceliumhq/mcp's BridgeableTool (a subset of this shape, minus `label`),
// so these tools pass straight into createMcpServer() without adaptation --
// see mcp-server.ts.
export type AgentToolResult<TDetails = unknown> = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: TDetails;
};

export interface AnyAgentTool<TParams = unknown, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  // Method shorthand (not an arrow-typed property) so TS checks `params`
  // bivariantly -- a factory can return `AnyAgentTool` (TParams defaulting to
  // unknown) while its `execute` takes a specific Static<typeof someSchema>.
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}

// Shared response envelope for every tool's execute(): the `text` is what the
// calling model reads, `details` carries the structured object for any
// non-model consumer (logs, UI). Mirrors ppl's client.ts#toToolResult, kept
// here since this app has no REST client module to hang it off.
export function toToolResult<T>(result: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

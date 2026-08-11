import { describe, expect, it } from "vitest";
import { createAllTools } from "../mcp-server.js";
import type { SignalToolDeps } from "./deps.js";
import { filterReadOnlyTools, READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from "./read-only.js";

// Stub deps -- createAllTools only wires factories; nothing is invoked here.
const stubDeps = {
  client: {} as SignalToolDeps["client"],
  store: {} as SignalToolDeps["store"],
  semantic: { available: false } as SignalToolDeps["semantic"],
};

describe("read-only tool classification", () => {
  const tools = createAllTools(stubDeps);
  const names = tools.map((t) => t.name);

  it("classifies every registered tool as exactly read-only or write", () => {
    const classified = new Set([...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    for (const name of names) {
      expect(classified.has(name), `tool ${name} is unclassified`).toBe(true);
    }
  });

  it("has no classified name that isn't a registered tool", () => {
    for (const name of [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES]) {
      expect(names, `classified name ${name} is not registered`).toContain(name);
    }
  });

  it("drops exactly the write tools in read-only mode", () => {
    const kept = filterReadOnlyTools(tools, true).map((t) => t.name);
    for (const name of WRITE_TOOL_NAMES) expect(kept).not.toContain(name);
    for (const name of READ_ONLY_TOOL_NAMES) expect(kept).toContain(name);
  });

  it("is a no-op when read-only mode is off", () => {
    expect(filterReadOnlyTools(tools, false)).toHaveLength(tools.length);
  });
});

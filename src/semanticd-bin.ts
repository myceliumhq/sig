#!/usr/bin/env node
import { runSemanticd } from "@myceliumhq/semanticd";
import { createAdapter } from "./semantic-adapter.js";

// Thin binary: the adapter is real TypeScript, passed directly to
// runSemanticd() and checked at compile time -- nothing here is resolved from a
// module specifier/export name pair at runtime.
runSemanticd(createAdapter()).catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeStderr,
  writeTable,
} from "@myceliumhq/toolkit";
import { MAX_SEARCH_LIMIT } from "../../limits.js";
import { resolveClient } from "../config.js";

const MAX_LIMIT = MAX_SEARCH_LIMIT;
const DEFAULT_LIMIT = 10;

export function registerSearch(program: Command): void {
  addSubcommand(program, "search <query...>")
    .summary("Search stored message text, hybridized with semantic search when configured.")
    .description(
      "Free-text search over stored message bodies, via sig-server. Lexical by default; when the " +
        "server has SIGNAL_SEMANTICD_URL configured, results are fused with a semantic pass (RRF) " +
        "automatically -- no separate mode to pick. --json rows then include match_source " +
        "(lexical/semantic/both); a result set with zero lexical hits (all `semantic`) prints a " +
        "stderr warning, since cosine similarity has no calibrated zero-results floor.",
    )
    .option("--limit <n>", `Max results, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--json", "Emit JSONL (one result per line) instead of a table.")
    .addHelpText("after", '\nExample: sig search "dinner plans"')
    .action(async (queryParts: string[], options: { limit: string; json?: boolean }) => {
      const query = queryParts.join(" ");
      const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });
      const result = await resolveClient().search(query, limit);

      // The real no-match signal: fusion still returns nearest-neighbor
      // semantic hits for nonsense queries, so zero lexical hits -- not an empty
      // list -- is what actually means "this query found nothing."
      if (result.usedSemantic && result.lexicalCount === 0 && result.rows.length > 0) {
        const best = Math.max(...result.rows.map((r) => r.semantic_score ?? 0));
        writeStderr(
          `# no lexical matches for this query -- ${result.rows.length} semantic-only result(s) ` +
            `shown (best score ${best.toFixed(3)}). Semantic similarity is not a calibrated ` +
            "relevance score; verify relevance before relying on them.",
        );
      }

      if (options.json) {
        writeJsonLines(result.rows);
      } else {
        writeTable(result.rows, [
          { header: "TIME", value: (r) => r.time.slice(0, 19).replace("T", " "), maxWidth: 20 },
          { header: "FROM", value: (r) => r.sender ?? r.source, maxWidth: 22 },
          { header: "TS", value: (r) => String(r.ts), maxWidth: 15 },
          { header: "BODY", value: (r) => r.body.replace(/\s+/g, " "), maxWidth: 54 },
        ]);
      }
    });
}

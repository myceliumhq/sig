import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  runDoctorChecks,
} from "@myceliumhq/toolkit";
import { resolveClient, resolveServerConnection } from "../config.js";

export function registerDoctor(program: Command): void {
  addSubcommand(program, "doctor")
    .summary("Check sig-server config and reachability (including auth).")
    .description(
      "The `sig` CLI always talks to a sig-server over HTTP -- there is no local-socket/SQLite mode " +
        "-- so doctor checks that SIG_SERVER_URL/SIG_SERVER_TOKEN are set and that the server " +
        "answers with a valid token. `sig daemon` is the one command that stays local (it owns the " +
        "signal-cli child process); this doesn't check its socket directly, only that sig-server -- " +
        "which reads that daemon's store/socket -- is reachable.",
    )
    .action(async () => {
      const code = await runDoctorChecks([
        {
          name: "config (SIG_SERVER_URL / SIG_SERVER_TOKEN)",
          run: async () => {
            resolveServerConnection();
          },
        },
        {
          name: "sig-server reachability + auth (GET /v1/health)",
          run: async () => {
            const health = await resolveClient().health();
            if (!health.ok) {
              throw new Error("sig-server responded but reported an unhealthy state");
            }
          },
        },
      ]);
      if (code !== EXIT_CODES.ok) {
        throw new CliError("doctor checks failed", { exitCode: code });
      }
    });
}

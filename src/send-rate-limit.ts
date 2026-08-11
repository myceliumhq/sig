// In-memory, per-process self-protection against agent-driven send spam,
// mirroring wacli's design: a 5-second warn-not-block threshold, surfaced to
// the caller rather than silently enforced, so the risk of the account being
// rate-limited/flagged by Signal's own servers is visible before it happens.
//
// This is intentionally NOT persisted or cross-process: sig-server and the
// standalone MCP server are two independent processes, each holding its own
// module-level clock. That's fine -- the point is catching a burst of calls
// within one running process (an agent hammering the same MCP session, or
// several `sig send` invocations hitting the same sig-server), not building
// distributed rate limiting for a single-user tool.
//
// Extended to reactions as well as sends (see tools/messaging.ts): a rapid
// burst of reactions can spam-annoy a chat just as visibly as a burst of
// messages, and the guard is cheap enough that there's no reason to special-
// case sends only.

const WARN_THRESHOLD_MS = 5_000;

export type SendRateLimiter = () => string | undefined;

// Returns a checker closure holding its own `lastSendAt`. Call it once per
// send/reaction attempt; it always records the attempt (so back-to-back
// rapid calls compound rather than resetting the window on every warning)
// and returns a warning string when the previous call was within the
// threshold, or undefined otherwise.
export function createSendRateLimiter(thresholdMs: number = WARN_THRESHOLD_MS): SendRateLimiter {
  let lastSendAt = 0;
  return () => {
    const now = Date.now();
    const previous = lastSendAt;
    lastSendAt = now;
    if (previous !== 0 && now - previous < thresholdMs) {
      return (
        `sent again ${now - previous}ms after the previous send/reaction (< ${thresholdMs}ms) -- ` +
        "repeated rapid sends risk this account being rate-limited or flagged by Signal"
      );
    }
    return undefined;
  };
}

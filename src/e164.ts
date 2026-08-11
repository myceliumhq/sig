// E.164: a leading "+" then 8-15 digits (ITU-T E.164's actual max length),
// nothing else. Shared by the CLI (src/cli/api.ts, exit-code-mapped) and the
// MCP tools (src/tools/messaging.ts, thrown as a plain Error) so a malformed
// recipient is rejected identically -- and as early as possible, before ever
// reaching signal-cli -- on both surfaces.
const E164_RE = /^\+[1-9]\d{7,14}$/;

export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

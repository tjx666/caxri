---
kind: living
status: current
---

# Provider messaging support

Caxri Peer Inbox delivery is capability-detected per managed Agent Endpoint. Endpoint health is
independent from the PTY: messaging may become unavailable while the Terminal continues running.

## Verified matrix

| Provider    | Controlled version | Stable delivery | Reason                                                                                         |
| ----------- | ------------------ | --------------- | ---------------------------------------------------------------------------------------------- |
| Claude Code | 2.1.231            | `pull`          | The bundled Caxri CLI returns bounded peer-origin text directly to the managed Endpoint.       |
| Codex       | 0.147.0            | `pull`          | Codex has no documented peer-origin push boundary; the bundled Caxri CLI is the safe boundary. |

The Runtime probes the configured executable and version with a five-second timeout and a bounded
cache. Missing, disabled, timed-out, malformed, or unsupported results fail closed as
`unavailable`; they never fall back to Terminal input, transcript parsing, or Provider private
storage. Fake Provider fixtures are version-independent but remain explicitly E2E-only.

Claude Code Channels can preserve non-user source metadata through
`notifications/claude/channel`, but custom channels are still a research preview that require the
explicit `--dangerously-load-development-channels` launch flag. Caxri does not add that flag or
advertise stable push. A future allowlisted channel integration must never declare the separate
`claude/channel/permission` capability, because peer messages cannot approve tool permissions.
See the official [Channels guide](https://code.claude.com/docs/en/channels) and
[Channels reference](https://code.claude.com/docs/en/channels-reference).

## Delivery boundary

- `wait` blocks for one message and reports `message` or `timed_out`.
- `check` performs one non-blocking read and reports `message` or `empty`.
- A pull becomes `delivered` only after the authenticated Host reply flushes. Cancellation,
  timeout, or disconnect never consumes a reserved message.
- Disabling the integration revokes adapter authority and fails pending text without stopping the
  PTY. Re-enabling re-probes the live generation.
- The Host-side push adapter contract requires an exact delivery ID acknowledgement. Failed,
  missing, or stale acknowledgements never report success.

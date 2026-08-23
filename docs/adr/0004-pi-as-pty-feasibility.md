# Pi is PTY-feasible but not approved as a production provider

- Status: accepted
- Date: 2026-08-24
- Refs: [#148](https://github.com/tjx666/caxri/issues/148)

## Decision

Pi is feasible as a future Caxri-managed PTY provider. The production provider remains a no-go
until its caller-owned identity, hook transport, and authenticated real-model boundary are reviewed
and implemented explicitly. This spike does not add Pi to `AgentProvider`, does not introduce an RPC
chat/tool surface, and does not add a generic PTY/RPC adapter hierarchy.

The provider shape, if separately authorized later, is narrow:

- Caxri mints an opaque Pi session ID before launch and persists it against the Agent Terminal.
- Runtime launches `pi` with structured argv containing `--session-id <id>` and an isolated
  `--session-dir <dir>`.
- Restart launches the same ID; Desktop relaunch reattaches to the existing Host-owned PTY.
- Pi has no standalone official metadata index. Its descriptor's `readState` returns `undefined`,
  and Agent status falls back to Caxri's process state.
- A reviewed Pi extension may emit bounded lifecycle signals. Caxri never enumerates, reads, parses,
  or writes Pi session JSONL to derive UI metadata.

## Official baseline

The spike pins the official
[`@earendil-works/pi-coding-agent` v0.84.2 release](https://github.com/earendil-works/pi/releases/tag/v0.84.2)
at commit [`914cf147`](https://github.com/earendil-works/pi/tree/914cf1472e715297caa30db4b9535d534a9eb718).
The package and repository are [MIT licensed](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/LICENSE).
The isolated macOS arm64 release archive matched the official checksum
`c996e888b7f7dce44bcf24f69176ac646c44139d3916bd49a6b28e5a8c5e3a65` and reported
version `0.84.2`; it was not installed globally. The extracted executable's pinned checksum is
`d5de3fe32f9e109324f32d6e393554fb2ce10bbc82e8ff935ab2e072f5e2f044`; the harness verifies that
digest and requires its canonical path to remain under a Caxri-named operating-system temporary
directory before execution.

The tagged CLI contract exposes `--session`, `--session-id`, `--session-dir`, `--version`, explicit
extension and skill flags, project-trust classification, and offline mode in
[`args.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/cli/args.ts#L263-L303).
`--session-id` selects an exact existing project session or creates one with that ID in
[`main.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/main.ts#L438-L450).
The validator permits alphanumeric characters with internal `-`, `_`, and `.`, but not `/`, and
requires an alphanumeric first and last character in
[`session-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L208-L218).

Pi deliberately delays writing a new session file until an assistant message exists. The spike
therefore used a deterministic localhost model stub to create a resumable official Pi session
without an account or credential. That stub proves the CLI lifecycle and persistence path only; it
is not evidence of real-model inference.

## Isolation and evidence rules

The reusable `spike:pi` harness accepts one absolute official binary path and creates a fresh
temporary root containing the project, HOME, Pi config, session, extension, and temporary
directories. Pi receives an allowlisted environment rather than `process.env`: no ambient account,
credential, proxy, real HOME, or Pi config enters the process. Every Pi launch uses `node-pty` with
an executable and argv array. The isolated Electron probe likewise receives a fresh temporary HOME
and an allowlisted environment.

The explicit test extension registers the localhost model and records only documented lifecycle
hook names, reasons, and `ctx.sessionManager.getSessionId()` into a spike-owned event file. The
harness never lists or opens Pi's session directory. It retains only bounded booleans, exit status,
signal, version, and lifecycle counts; it does not retain Terminal output.

The only unavailable proof is:

`REAL_MODEL_CREDENTIAL_NOT_AVAILABLE_TO_ISOLATED_RUN`

No credential was supplied to the isolated run, and the spike was forbidden from discovering or
reusing an ambient account. Consequently, authenticated model output and account-specific
permission prompts remain unclaimed. No other matrix item depends on that credential.

## Lifecycle matrix

| Case                 | Evidence                                                                                                       | Result                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Create               | Official Pi PTY, Caxri-minted `caxri-<uuid>`, isolated session directory, one deterministic assistant response | Passed; exit code 0                                             |
| Resume               | Standalone relaunch plus Caxri Restart receipt; both reused the same caller-owned ID                           | Passed; official Pi received the exact ID                       |
| Normal exit          | Explicit extension command called Pi's documented graceful shutdown                                            | Passed; exit code 0, signal 0                                   |
| Process interruption | Standalone idle `SIGTERM`; Desktop active-request `SIGTERM` followed by Restart                                | Passed; neutral stopped state, then same-ID resume              |
| Caxri Restart        | Test-owned binding plus a spike receipt proved incoming `resume <id>` became Pi `--session-id <id>`            | Passed; same Terminal ID, new Pi PID, same caller-owned Pi ID   |
| App relaunch         | First Desktop closed while the isolated Host, Runtime, and Pi PTY stayed live; second Desktop reconnected      | Passed; same Terminal record, Pi PID, Host PID, and Runtime PID |
| Invalid session      | Space-containing `--session-id`                                                                                | Passed; fail-closed exit code 1                                 |
| CLI missing          | Standalone nonexistent Pi path plus provider-neutral Desktop recovery surface                                  | Passed; failed/danger status, Restart offered, no fake Pi ID    |
| Abnormal exit        | Standalone and Desktop `SIGKILL`; Desktop then restarted the official Pi process                               | Passed; dead/danger state, then same-ID resume                  |

The focused desktop test uses the repository-wide desktop lease and an isolated E2E user-data
directory. It never stops or reuses a sibling worktree's process. `scripts/pi-pty-feasibility.ts`
owns the standalone matrix; `e2e/pi-pty-feasibility.e2e.ts` owns Restart, Desktop relaunch, active
interruption, abnormal exit, and missing-CLI recovery. Because this spike cannot add a production
Pi catalog entry, the desktop test uses Caxri's existing fake-executable authority under the Codex
test kind and a test-owned synthetic Codex index to bind the Caxri-owned spike ID to the Terminal.
The generated shim forwards Caxri's version probe, records only spike-owned invocation receipts,
and replaces the launch with official Pi via `execve`. Its receipt proves that Caxri's incoming
`resume <id>` is translated to Pi's `--session-id <id>`; it never reads Pi's session files. This is
provider-neutral PTY lifecycle evidence, not evidence that Codex arguments or policy are valid for
Pi and not a production Pi identity implementation.

## Capability matrix

| Capability                | Official Pi v0.84.2                                                                                                | Caxri decision                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Launch/resume             | `--session-id` and `--session-dir`; exact ID creates or resumes                                                    | Feasible with a Caxri-minted ID and structured argv                                      |
| Version                   | `--version` returns `0.84.2`                                                                                       | Existing probe is feasible; the desktop shim forwards it to official Pi                  |
| Image                     | TUI accepts image file input and provider models declare image input                                               | Feasible, but real-model image transport remains behind the credential blocker           |
| Hooks                     | Extensions expose project trust, session, agent, turn, message, and tool lifecycle events                          | Use only a reviewed bounded extension; do not infer state from persisted sessions        |
| Messaging                 | TUI supports steering/follow-up; RPC also supports programmatic messaging                                          | Do not use RPC; a future Host bridge requires an explicit Pi hook design                 |
| Skills                    | `--skill`, `--no-skills`, global/project discovery, and project trust gate                                         | Feasible through the provider descriptor's existing action-discovery contract            |
| Permission classification | `--approve` trusts project-local resources; `--no-approve` ignores them                                            | This is resource trust, not a tool sandbox or unrestricted-permission mode               |
| Endpoint                  | Standalone PTY exposes no Endpoint; ordinary RPC is stdin/stdout JSON messages; experimental PiServer is a library | No production Agent Endpoint claim in this spike                                         |
| Metadata index            | No standalone official index; Pi's own session listing enumerates and parses persisted session files               | `readState` returns `undefined`; process state supplies running/completed/failed/unknown |

The fallback already exists in `src/runtime/agents/service.ts`: missing local state maps through
`processStateToAgentActivity`. The spike-only `readPiSpikeState` contract returns `undefined`, and
the standalone harness verifies the resulting mapping: `starting/running -> running`,
`stopped -> completed`, `dead/failed -> failed`, and no process state to `unknown`. The Desktop
test's synthetic index binds a test Terminal without claiming that Pi has an index. Because this
spike deliberately adds no Pi provider descriptor, it does not claim a production Pi `readState`
or Agent-metadata UI integration; that cross-boundary implementation belongs to the separately
authorized production follow-up.

## Competitor evidence

The relevant PTY precedent is Orca at commit
[`c3a1694b`](https://github.com/stablyai/orca/tree/c3a1694b1d3023d7359f7c5811a5d9ea8c63c294).
Its [Pi launch descriptor](https://github.com/stablyai/orca/blob/c3a1694b1d3023d7359f7c5811a5d9ea8c63c294/src/shared/tui-agent-config.ts#L136-L145)
uses a real PTY, explicit Pi process detection, argv prompt injection, and a Pi extension for startup
coordination. Its daemon/process-group ownership and fail-closed attach behavior are useful
precedents. Its session scanner and provider-specific persisted-session parsing are explicitly not
precedents for Caxri.

Paseo at commit
[`b5f5832`](https://github.com/getpaseo/paseo/tree/b5f583221436056e1fee2a3179d568a4c5ce85b9)
launches Pi with `--mode rpc` in
[`runtime.ts`](https://github.com/getpaseo/paseo/blob/b5f583221436056e1fee2a3179d568a4c5ce85b9/packages/server/src/server/agent/providers/pi/runtime.ts#L107-L125)
and discovers metadata by enumerating Pi JSONL in
[`session-descriptor.ts`](https://github.com/getpaseo/paseo/blob/b5f583221436056e1fee2a3179d568a4c5ce85b9/packages/server/src/server/agent/providers/pi/session-descriptor.ts#L170-L202).
Jean likewise presents Pi as a structured chat backend rather than a Terminal-native provider.
Those products demonstrate richer RPC UI possibilities, but both ownership shapes are outside this
decision and cannot be copied into Caxri's PTY spike.

## Production follow-ups

A later production issue must make these decisions explicitly rather than silently inheriting
Claude or Codex behavior:

1. Add `pi` to the exhaustive provider catalog and define launch/resume, version, image, hooks,
   messaging, skills, permission, Endpoint, and metadata-index policy individually.
2. Persist the Caxri-minted Pi session ID before the first process generation and preserve it across
   Restart even though `readState` is always `undefined`. The current provider flow assumes local
   metadata can establish the initial binding, so the new identity seam must be narrow and tested.
3. Design a bounded Pi extension signal transport if activity, attention, or Host messaging is
   required. Do not add a general `PtyAgentAdapter`/`RpcAgentAdapter` hierarchy.
4. Run authenticated text and image smoke tests only after a user explicitly supplies an isolated
   account/credential authority. Record provider-specific permission prompts without exposing the
   credential.

Until those follow-ups are authorized and pass review, the production provider decision remains
no-go even though the PTY transport decision is go.

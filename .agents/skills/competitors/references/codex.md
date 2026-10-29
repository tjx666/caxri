# Codex provider reference

Research date: 2026-09-10. Local source reference: `fc7d34ad` (2026-08-31) in
`competitors/codex`; installed CLI verified separately as 0.153.4. The clone is not an exact
installed-version snapshot. No implementation code was copied.

## Visible delegation identity and finality

- The [official hooks reference](https://developers.openai.com/codex/hooks) exposes `session_id`,
  `UserPromptSubmit.turn_id` and `prompt`, plus `Stop.turn_id` and `last_assistant_message`.
  Hook trust is an explicit native boundary; do not add a trust-bypass flag to make a probe work.
- `codex-rs/core/src/session/turn.rs:505` runs Stop hooks before final task completion. A blocking
  hook continues the same turn context and turn ID. Stop cannot be treated as final output.
- `codex-rs/core/src/tasks/mod.rs:830` emits `TurnComplete` after the whole task finishes.
  `codex-rs/protocol/src/protocol.rs:1394` serializes it as `task_complete`, with `turn_id`,
  `last_agent_message` and optional structured error information. `rollout/src/policy.rs:109`
  persists it in both legacy and paginated histories; user-message representation differs by mode.
- The safe association is owned launch, authenticated pointer digest and turn ID, provider-located
  native session file, then exact terminal event. Requiring legacy user-message ancestry adds a
  fragile format dependency without strengthening this ownership proof.
- A content-free controlled probe of 0.153.4 confirmed positional initial prompts automatically
  submit and start/Stop carry the same turn ID. It used existing trusted hooks, read-only sandbox,
  no approvals, and cleaned its process and exact synthetic session files.
- The real Caxri path also returned three distinct exact synthetic answers for initial delegation,
  same-Terminal follow-up, and native resume, retaining the caller focus and a single native session.
- Hook trust includes positional event/group/handler keys as well as the normalized command hash.
  Removing and appending an owned group invalidates neighboring user hooks. Ordinary configuration
  repair must retain group positions; digest opt-in does not require changing hook command schema.
- Codex `--add-dir` grants write access. A private task pointer must not implicitly add this grant.
  A real caller's ability to connect to the Caxri Unix socket remains a separate sandbox probe.

See [Caxri delegation](../../../../docs/agent-delegation.md) for the current implementation contract.

## Mouse selection in hosted terminals

Research date: 2026-09-24. Local source reference: `3938a27c` (2026-09-21); installed CLI:
0.156.1. The source snapshot is not an exact installed-version match.

- The TUI enables mouse capture and handles transcript drag selection internally. Its highlight
  does not create an xterm selection, so a host listening to xterm `onSelectionChange` cannot use
  that drag as a copy-on-select signal.
- The current [official source](https://github.com/openai/codex/blob/2230d644/codex-rs/tui/src/slash_command.rs)
  describes `/raw` as copy-friendly scrollback mode; the local source accepts `/raw on` and `/raw off`.
  The `/toggle-mouse-mode` workaround in an [older issue](https://github.com/openai/codex/issues/1247)
  should not be recommended for the current TUI without version verification.
- xterm's `mouseEventsRequireAlt` makes ordinary drag select terminal text and reserves Alt-drag
  for TUI mouse input; wheel events are unaffected. `macOptionClickForcesSelection` instead keeps
  TUI mouse input as the default and requires Option-drag for terminal selection. These are host
  interaction choices, not transcript parsing fixes.

## Mobile remote control

_Researched 2026-09-24 from OpenAI help and developer docs plus public issues._

- The ChatGPT iOS/Android app's Remote tab controls Codex on a paired Mac or PC (QR pairing from the desktop app) or a headless `codex remote-control start` host, through OpenAI's relay. It requires an account; execution stays on the host.
- The relay carries JSON-RPC over TLS to OpenAI without end-to-end encryption, unlike Codex's Noise-based `exec-server` channel; a public issue asks for parity. Another asks for re-authentication before destructive actions from a phone.
- Mobile UX: unified Session list across hosts, live transcript with diffs and approvals, one-screen new Session (host, workspace, branch, optional worktree), explicit Queue vs Steer for follow-ups sent mid-turn, `/side` tangent threads, and a model/effort picker. The Terminal is a read-only stream.
- Public sentiment (X, Aug–Sept 2026): praised as the most complete remote experience (especially starting work from the phone and voice) and heavily criticized for disconnects, reconnect loops, and desync, with Android behind iOS.

## Remote control relay protocol (2026-10-29)

Comparison: [relay-servers.md](relay-servers.md). `codex-rs/app-server-transport/src/transport/remote_control/`
enrolls the host with the ChatGPT backend for a short-lived bearer token and keeps one WebSocket carrying JSON-RPC
envelopes with `client_id`, `stream_id`, `seq_id`, acks, and base64 chunking for large messages. The protocol has no
application-layer encryption, and hosts are restricted to the vendor domain, so self-hosting is impossible.

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

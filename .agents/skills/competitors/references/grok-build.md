# Grok Build

Research date: 2026-09-10. Public source: [37949780](https://github.com/xai-org/grok-build/commit/37949780),
Apache-2.0. The installed CLI reports 1.0.24 (`68e414c661e3`); that commit is unavailable in the public
repository, so source inspection does not establish binary parity.

## Native delegation contracts

- Interactive launch accepts a preallocated `--session-id`; `--resume` selects an exact existing
  conversation. The managed task owns both selectors. Help exposes no noninteractive rename command.
- Transcript location is `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`. Long encoded
  paths use a hashed directory plus `.cwd` marker. See `xai-grok-config/src/paths.rs`.
- The durable `turn_completed` extension includes exact `prompt_id`, stop reason and optional native
  usage. Its `agent_result` is error detail, not a successful answer: trace
  `xai-grok-shell/src/sampling/error.rs` through `session/acp_session_impl/turn_end.rs`.
- ACP `agent_message_chunk` text is persisted and adjacent chunks may merge. `response_started` and
  `response_completed` use a buffered live rail that does not persist. Trace
  `session/acp_session_impl/updates.rs` and `session/persistence.rs`; declarations alone are misleading.
- Stop-hook feedback can cause another model response without a persisted user-message boundary.
  A rejected draft and final answer can therefore share one text chunk. The Stop payload's
  `lastAssistantMessage` selects the trailing assistant report, excluding Stop-hook feedback; see
  `xai-chat-state/src/actor/queries.rs`. Its digest and UTF-8 byte length can authenticate an exact
  suffix, but only when receipt counts match native `hook_execution` Stop batches and the last batch
  allows stopping. Forced continuation limits and delivery loss must fail closed.
- Stop text is clipped above 32,768 Unicode characters with an omitted-character footer. A clipped
  digest cannot authenticate the missing text. The durable final marker drains pending ACP writes.
- Hook envelopes use `sessionId`, `promptId`, `lastAssistantMessage`, and optional native-child
  scope. `SessionStart` does not identify children; use the first scoped prompt for binding. A
  session-end Stop has no prompt or answer. Truncated payloads cannot prove parent scope.
- Hook discovery supports `$GROK_HOME/hooks/*.json`. Global configuration remains an explicit opt-in
  boundary. CLI read-only sandbox startup on this host refused to proceed because protections could
  not be applied; no native task or binary-format validation was obtained from those probes.

All referenced source paths are beneath `crates/codegen/` in the pinned public commit. Product
behavior and current limitations live in [visible delegation](../../../../docs/agent-delegation.md).

# Fixtures: Caxri Acceptance

Caxri-specific facts for deterministic Project and state setup. Probe and mock
recipes live in [`../probe-mock-patterns.md`](../probe-mock-patterns.md).

## FX1. Project roots are supplied through Main's existing test resolver

The Acceptance launcher converts repeated `--test-root PATH` arguments into
`CAXRI_TEST_ROOT_PATH` and `CAXRI_TEST_ROOT_PATHS`. Main consumes queued roots in
order, then retains the last root. This exercises the real Project authorization
path while preventing setup from opening a native folder picker.

Use a purpose-built temporary fixture for the case. Default to the repository
root only when the requirement actually needs a real large Project; otherwise
the extra files, Git state, and watcher load contaminate the evidence.

## FX2. Mutating cases do not inherit each other's profiles

Every state-mutating case defaults to an isolated profile and must produce its
own state-isolation receipt. Reusing a profile is valid only for a plan item that
declares `stateIsolation: restart`, names the profile, and cleans it up on the
final launch. Another case's selected Session, settings, archived state, or
cleanup result is not a fixture.

## FX3. Native dialog responses are fixtures, not native-surface evidence

A controlled Main dialog response can prove product behavior before and after
the native boundary. It cannot prove the title, layout, controls, or interaction
of the macOS dialog itself. Keep that distinction explicit in the plan and final
report.

## FX4. Agent behavior uses a plan-bound process fixture

Every Acceptance launch replaces the host HOME, XDG directories, Agent provider homes, and shell
PATH with isolated profile-owned paths, and blocked Agent shims are the default. When the case plan
declares the fixed `agent-features-v1` fixture and the launch passes the same id with
`--agent-fixture`, the launcher replaces only the blocked Claude Code and Codex targets with fixed
fake executables. The fakes exercise
the real PTY, hook, metadata, and provider rename boundaries; they do not inject Main or Runtime
events. Arbitrary executable paths, source, environment overrides, and host provider state are not
fixture inputs.

The `grok-build-v1` fixture replaces only Grok. Its fixed commands are `fixture:start`,
`fixture:finish`, `fixture:fail`, `fixture:new`, `fixture:shutdown`, and `fixture:exit`.
It writes content-free identity receipts and an observed grid marker under its isolated Grok
home. Pair that marker with the actual Renderer rows for Terminal fixture preflight.

The generated `assets/<case-id>-agent-fixture.json` receipt binds the launch to the frozen fixture
and records whether its owned profile was cleaned. Include it in the case evidence; report
finalization rejects a missing, mismatched, or incompletely cleaned receipt.

The `agent-delegation-v1` fixture provides Claude Code, Codex, and Grok Build. Each target reads a
private synthetic task pointer, emits correlated native hooks, and saves the fixed task result
in the isolated provider home. Use it to verify visible delegation and caller focus without
launching a host Agent.

The `agent-chat-v1` fixture replaces Claude Code and Codex with the deterministic Agent Chat fakes
the E2E suite uses (stream-json and app-server JSON-RPC). Message keywords drive replies, approvals,
and file-change diffs; the fakes' header comments list them.

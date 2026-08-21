---
id_prefix: logic
verify: true
skip_when: human-facing docs or lockfile-only change
---

# Correctness

Check whether the change satisfies the stated behavior under real inputs and failure ordering.

## Quick checklist

- Requirement or acceptance-criteria drift, including a product decision recorded in the issue,
  PR, or conversation that the implementation silently contradicts
- Empty, missing, stale, duplicate, first/last, capacity-limit, and already-deleted states
- Async ordering mistakes: un-awaited writes, stale responses winning, shared cancellation,
  attach-before-subscribe races, or cleanup running before ownership is settled
- Error paths that leave the UI stuck, durable state half-written, a PTY orphaned, or a request
  pending forever
- State-machine gaps across creating, running, detached, exited, dead, restarting, and disposed
- A bug fix without a behavior-level regression that fails for the original scenario
- Tests that assert a mock call but do not observe the user-visible or process-boundary result
- A framed transport does not preserve submission order and frame boundaries across partial writes,
  or does not define duplicate-request, late-reply, peer-close, and retry behavior together

## How to check

1. Start from the requirement and enumerate the observable success and failure states.
2. Trace changed async operations to their terminal state, including cancellation and disposal.
3. Chase callers and schemas before claiming an input is reachable.
4. Read the focused test and confirm it covers the reported behavior rather than an implementation
   detail.
5. For framed transports, trace one partial write, two overlapping requests, a duplicate request, a
   reply after cancellation, and peer close. Verify ordering and idempotency at the layer that owns
   each transition.

## Rule sources

- `.agents/skills/quality-check/SKILL.md`
- `.agents/skills/unit-testing/SKILL.md` and `.agents/skills/e2e-testing/SKILL.md`
- `.agents/skills/debug/SKILL.md` when the change is a bug fix

## Not violations

- Inputs rejected by the typed boundary before reaching the changed code
- Missing component unit tests when the behavior belongs in focused Electron E2E
- Pure glue with no branch, state, or failure behavior

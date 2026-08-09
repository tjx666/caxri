# Caxri desktop evidence contract

Every Caxri Acceptance case uses the `desktop` surface and stores its artifacts
inside the current immutable round's `assets/` directory.

## Evidence media

| Type           | Use when                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- |
| `screenshot`   | Settled Renderer state, layout, styling, or visual hierarchy is the claim                    |
| `dom_snapshot` | Renderer structure or accessible content supports the visual observation                     |
| `gif`          | A short transition or state change is the claim                                              |
| `video`        | A longer interaction, streaming sequence, or multi-step flow needs continuous proof          |
| `text`         | Focused command output, logs, or computed observations support a non-visual desktop behavior |
| `transcript`   | Terminal or agent event order is itself part of the user-visible behavior                    |

The `requiredEvidence` declaration is binding. A final screenshot cannot replace
a required temporal recording, and prose cannot replace a required screenshot.

## Artifact rules

- Reference artifacts from `cases[].evidence` with paths relative to the report
  directory, for example `assets/terminal-layout.png`.
- Every pass, fail, or blocked observation needs the evidence that supports that
  status.
- Inspect every image, clip, and generated document before citing it.
- Never upload credentials, cookies, tokens, private user data, unrelated host
  windows, notifications, or a developer's resident Caxri state.
- Prefer a focused artifact over an unfiltered log or full-session recording.
- Retain source frames while a derived GIF or video is awaiting review.

## Non-visual desktop behavior

When terminal, Runtime, IPC, persistence, or security behavior cannot be proven
by pixels alone, attach two separate `text` artifacts:

1. a concise reasoning artifact containing the claim, setup, method, expected
   result, interpretation, and limitation;
2. an execution artifact containing the exact command or interaction, relevant
   raw observations, exit or status values, and their mapping to the expectation.

These artifacts support the real Electron path; they do not create another
product surface.
